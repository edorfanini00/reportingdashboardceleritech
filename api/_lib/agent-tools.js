// Tool registry for the GoHighLevel AI assistant.
// Each tool has: name, description, input_schema (Anthropic format), write flag,
// and a run(input) executor. Write tools only mutate when input.confirmed===true;
// otherwise they return a preview so the assistant can ask the user to confirm.

const ghl = require('./ghl-client');
const { validateJob, countTargets } = require('./bulk');

const BULK_TOOL_OPS = {
  bulk_update_contacts: () => 'update_contact',
  bulk_tag_contacts: input => (input.mode === 'remove' ? 'remove_tags' : 'add_tags'),
};

// Vet a bulk job BEFORE it is previewed or queued.
//
// Everything that could make a bulk job silently do nothing is caught here,
// while the assistant is still talking to the user:
//   - an owner name that matches no GoHighLevel user
//   - a field that exists on neither the contact nor its custom fields
//   - an audience that resolves to 0 contacts, or to a count that disagrees
//     with what the user asked for (i.e. a wrong Smart List filter guess)
// A rejected job returns { error }, so the assistant has to report the problem
// instead of claiming the work is done.
async function vetBulkJob(op, input) {
  const { fields, tags, tag, allTags, filters, query, expectedTotal } = input;
  const ids = Array.isArray(input.contactIds) && input.contactIds.length
    ? [...new Set(input.contactIds.filter(Boolean))]
    : null;
  const hasFilters = Array.isArray(filters) && filters.length;
  if (!ids && !tag && !hasFilters && !query) {
    return { error: 'No audience given. Pass contactIds, tag, or filters (verify the filters with count_contacts first).' };
  }

  // Payload preflight: resolves "Kimberly" to a user id, rejects bad fields.
  let validated;
  try {
    validated = await validateJob(op, { fields, tags });
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }

  // Audience preflight, so the assistant always states the real number.
  let total = ids ? ids.length : null;
  if (total == null) {
    try {
      total = await countTargets({ tag, filters: hasFilters ? filters : null, query });
    } catch { total = null; }
  }
  if (total === 0) {
    return { error: 'That audience matched 0 contacts, so nothing was queued. Re-check the tag/filters with count_contacts and tell the user.' };
  }
  if (expectedTotal != null && total != null && Number(expectedTotal) !== total) {
    return {
      error: `Audience mismatch: these filters match ${total} contacts but the user expects ${expectedTotal}. Nothing was queued. Do NOT guess — ask the user for the exact Smart List filters, or ask them to tag the list in GoHighLevel (open the Smart List → select all → Add Tag) so it can be targeted by that tag.`,
      total,
      expectedTotal,
    };
  }

  return {
    total,
    notes: validated.notes || [],
    // Job spec held by the dashboard, which resolves targets and processes them
    // one by one with per-contact verification — no database needed.
    job: {
      op,
      fields: op === 'update_contact' ? validated.fields : null,
      tags: op === 'update_contact' ? null : validated.tags,
      tag: tag || null,
      allTags: allTags || null,
      filters: hasFilters ? filters : null,
      query: query || null,
      contactIds: ids,
      total,
    },
  };
}

function describeBulkOp(op, input, vetted) {
  if (op === 'update_contact') {
    const pairs = Object.entries(input.fields || {}).map(([k, v]) => `${k} = ${v}`).join(', ');
    return `set ${pairs}`;
  }
  const list = (vetted.job.tags || []).join(', ');
  return `${op === 'remove_tags' ? 'remove' : 'add'} tag(s) ${list}`;
}

async function buildBulkJob(op, input) {
  const vetted = await vetBulkJob(op, input);
  if (vetted.error) return vetted;
  const { total, notes } = vetted;
  return {
    ok: true,
    bulk: true,
    op,
    total,
    bulkJob: vetted.job,
    notes: notes.length ? notes : undefined,
    message: `Queued: ${describeBulkOp(op, input, vetted)} on ${total == null ? 'the matching' : total} contacts.`
      + (notes.length ? ` (${notes.join('; ')})` : '')
      + ' The dashboard is processing them one by one (verified) with live progress below.',
  };
}

function contactSummary(c) {
  if (!c) return null;
  return {
    id: c.id,
    name: [c.firstName, c.lastName].filter(Boolean).join(' ') || c.contactName || c.name || '',
    email: c.email || '',
    phone: c.phone || '',
    company: c.companyName || '',
    source: c.source || '',
    tags: c.tags || [],
    assignedTo: c.assignedTo || '',
  };
}

const tools = [
  // ---------- READ ----------
  {
    name: 'search_contacts',
    write: false,
    description: 'Search GoHighLevel contacts. Provide email OR phone OR name OR a free-text query. Returns up to 20 matches with id, name, email, phone, company, source, tags.',
    input_schema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Exact email to match' },
        phone: { type: 'string', description: 'Phone number (any format)' },
        name: { type: 'string', description: 'Full or partial name' },
        query: { type: 'string', description: 'Free-text search across name/email/phone' },
      },
    },
    async run({ email, phone, name, query }) {
      let results = [];
      if (email) results = await ghl.searchContactsByEmail(email);
      else if (phone) results = await ghl.searchContactsByPhone(phone);
      else if (name) results = await ghl.searchContactsByName(name);
      else if (query) results = await ghl.searchContacts({ query });
      return { count: results.length, contacts: results.slice(0, 20).map(contactSummary) };
    },
  },
  {
    name: 'search_by_tag',
    write: false,
    description: 'Find contacts that have a specific tag. Returns a sample only — for bulk updates on many contacts, do NOT use this; pass the tag directly to bulk_update_contacts or bulk_tag_contacts instead.',
    input_schema: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: 'Exact tag name to search for (primary tag to paginate through)' },
        allTags: { type: 'array', items: { type: 'string' }, description: 'Optional: list of ALL tags the contacts must have (AND filter applied after fetching). Include the primary tag here too.' },
      },
      required: ['tag'],
    },
    async run({ tag, allTags }) {
      let results = await ghl.searchByTagEquals(tag, 100, 2);
      if (Array.isArray(allTags) && allTags.length > 1) {
        const required = allTags.map(t => t.toLowerCase());
        results = results.filter(c => {
          const cTags = (c.tags || []).map(t => t.toLowerCase());
          return required.every(r => cTags.includes(r));
        });
      }
      // Keep the payload compact so large lists don't bloat the model context
      // (which slows every subsequent call). Return all ids (small) but only a
      // sample of full details. For bulk actions, prefer passing `tag` to the
      // bulk tool, or these contactIds.
      const ids = results.map(c => c.id).filter(Boolean);
      const sample = results.slice(0, 25).map(c => {
        const s = contactSummary(c);
        return { id: s.id, name: s.name, email: s.email, company: s.company };
      });
      return {
        count: results.length,
        contactIds: ids,
        sample,
        note: results.length >= 200 ? 'Sample only (first 200). For bulk actions pass tag directly to bulk_update_contacts — do not pass these ids.' : undefined,
      };
    },
  },
  {
    name: 'count_contacts',
    write: false,
    description: `Count EXACTLY how many contacts match a set of advanced filters, plus a small sample. This is the tool that reproduces a GoHighLevel Smart List: Smart Lists are not exposed by the API, but they are just saved filters, so pass the same filters here and compare the total to the count the user sees in the UI. ALWAYS use this to verify an audience before running a bulk write on it.
Filters are ANDed. Wrap in {"group":"OR","filters":[...]} for OR logic.
Fields: id, contactName, firstName, lastName, email, phone, address, city, state, country (2-letter code, e.g. "VE"), postalCode, businessName, companyName, source, tags, assignedTo (user id), dnd, dateAdded, dateUpdated, followers, pipelineId, customFields.{fieldId} (get ids from list_custom_fields).
Operators: eq, not_eq, contains (min 3 chars), not_contains, exists, not_exists, range ({"gte":..,"lte":..}).
Example: [{"field":"country","operator":"eq","value":"VE"},{"field":"assignedTo","operator":"not_exists"}]`,
    input_schema: {
      type: 'object',
      properties: {
        filters: { type: 'array', items: { type: 'object' }, description: 'GoHighLevel advanced search filters (ANDed).' },
        tag: { type: 'string', description: 'Shortcut for a single tag filter.' },
        query: { type: 'string', description: 'Optional free-text search across searchable fields.' },
      },
    },
    async run({ filters, tag, query }) {
      const f = Array.isArray(filters) && filters.length
        ? filters
        : (tag ? ghl.tagFilters(tag) : null);
      const total = await ghl.countContacts({ filters: f, query });
      const { batch } = await ghl.searchFilterPage({ filters: f, query, page: 1, pageLimit: 5 });
      return {
        total,
        filters: f,
        sample: batch.map(c => {
          const s = contactSummary(c);
          return { id: s.id, name: s.name, email: s.email, company: s.company, assignedTo: s.assignedTo };
        }),
        note: 'If this total does not match the count the user gave you, the filters are wrong — do NOT write to this audience. Ask the user for the exact Smart List filters instead.',
      };
    },
  },
  {
    name: 'find_user',
    write: false,
    description: 'Resolve a person\'s name (or email) to a GoHighLevel user id — required before assigning an owner. Returns the matched user, or an error listing the real users when the name is unknown or ambiguous.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Name, email, or user id, e.g. "kimberly"' } },
      required: ['name'],
    },
    async run({ name }) {
      return ghl.resolveUser(name);
    },
  },
  {
    name: 'get_contact',
    write: false,
    description: 'Get full details for a single contact by its id.',
    input_schema: {
      type: 'object',
      properties: { contactId: { type: 'string' } },
      required: ['contactId'],
    },
    async run({ contactId }) {
      return contactSummary(await ghl.getContact(contactId));
    },
  },
  {
    name: 'list_pipelines',
    write: false,
    description: 'List all opportunity pipelines and their stages (with ids). Use to find pipelineId and pipelineStageId.',
    input_schema: { type: 'object', properties: {} },
    async run() {
      const pipes = await ghl.listPipelines();
      return pipes.map(p => ({ id: p.id, name: p.name, stages: (p.stages || []).map(s => ({ id: s.id, name: s.name })) }));
    },
  },
  {
    name: 'list_users',
    write: false,
    description: 'List location users (id, name, email). Use to find a user id for assignment (e.g. assigning to Natalie).',
    input_schema: { type: 'object', properties: {} },
    async run() {
      const users = await ghl.listUsers();
      return users.map(u => ({ id: u.id, name: `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.name || '', email: u.email || '' }));
    },
  },
  {
    name: 'list_workflows',
    write: false,
    description: 'List automation workflows already built in GoHighLevel (id, name, status). NOTE: workflows/bots can only be BUILT in the GHL dashboard; via API you can only list them and enroll/remove contacts.',
    input_schema: { type: 'object', properties: {} },
    async run() {
      const wfs = await ghl.listWorkflows();
      return wfs.map(w => ({ id: w.id, name: w.name || '', status: w.status || '' }));
    },
  },
  {
    name: 'list_calendars',
    write: false,
    description: 'List calendars in the location (id, name) for booking appointments.',
    input_schema: { type: 'object', properties: {} },
    async run() {
      const cals = await ghl.listCalendars();
      return cals.map(c => ({ id: c.id, name: c.name || '' }));
    },
  },
  {
    name: 'list_tags',
    write: false,
    description: 'List all tags defined at the location level (name + id).',
    input_schema: { type: 'object', properties: {} },
    async run() {
      const tags = await ghl.listLocationTags();
      return tags.map(t => ({ id: t.id, name: t.name || '' }));
    },
  },
  {
    name: 'list_custom_fields',
    write: false,
    description: 'List contact custom-field definitions (id, name, fieldKey). Use to find the right key when updating a custom field on a contact.',
    input_schema: { type: 'object', properties: {} },
    async run() {
      const map = await ghl.fetchCustomFieldMap();
      return Object.entries(map).map(([id, v]) => ({ id, name: v.name, fieldKey: v.fieldKey }));
    },
  },
  {
    name: 'get_notes',
    write: false,
    description: 'Get the notes on a contact by contactId.',
    input_schema: {
      type: 'object',
      properties: { contactId: { type: 'string' } },
      required: ['contactId'],
    },
    async run({ contactId }) {
      const notes = await ghl.getContactNotes(contactId);
      return notes.map(n => ({ id: n.id, body: n.body || '', createdAt: n.dateAdded || n.createdAt || '' }));
    },
  },
  {
    name: 'get_tasks',
    write: false,
    description: 'Get the tasks on a contact by contactId.',
    input_schema: {
      type: 'object',
      properties: { contactId: { type: 'string' } },
      required: ['contactId'],
    },
    async run({ contactId }) {
      const tasks = await ghl.getContactTasks(contactId);
      return tasks.map(t => ({ id: t.id, title: t.title || '', body: t.body || '', dueDate: t.dueDate || '', completed: !!t.completed, assignedTo: t.assignedTo || '' }));
    },
  },
  {
    name: 'search_opportunities',
    write: false,
    description: 'Search opportunities. Optional filters: query (text), pipelineId, pipelineStageId, contactId, assignedTo, status (open/won/lost/abandoned). Returns id, name, pipeline/stage, status, value, contactId.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        pipelineId: { type: 'string' },
        pipelineStageId: { type: 'string' },
        contactId: { type: 'string' },
        assignedTo: { type: 'string' },
        status: { type: 'string' },
      },
    },
    async run(params) {
      const opps = await ghl.searchOpportunities(params);
      return opps.slice(0, 20).map(o => ({
        id: o.id,
        name: o.name || '',
        pipelineId: o.pipelineId || '',
        pipelineStageId: o.pipelineStageId || o.stageId || '',
        status: o.status || '',
        value: o.monetaryValue != null ? o.monetaryValue : '',
        contactId: (o.contact && o.contact.id) || o.contactId || '',
      }));
    },
  },
  {
    name: 'get_opportunity',
    write: false,
    description: 'Get a single opportunity by id.',
    input_schema: {
      type: 'object',
      properties: { opportunityId: { type: 'string' } },
      required: ['opportunityId'],
    },
    async run({ opportunityId }) {
      return ghl.getOpportunity(opportunityId);
    },
  },
  {
    name: 'list_conversations',
    write: false,
    description: 'Search conversations, optionally for a specific contactId. Returns conversation ids and last message preview.',
    input_schema: {
      type: 'object',
      properties: {
        contactId: { type: 'string' },
        query: { type: 'string' },
      },
    },
    async run(params) {
      const convos = await ghl.searchConversations(params);
      return convos.slice(0, 20).map(c => ({ id: c.id, contactId: c.contactId || '', lastMessage: c.lastMessageBody || '', type: c.type || '' }));
    },
  },
  {
    name: 'get_messages',
    write: false,
    description: 'Get the messages in a conversation by conversationId.',
    input_schema: {
      type: 'object',
      properties: { conversationId: { type: 'string' } },
      required: ['conversationId'],
    },
    async run({ conversationId }) {
      const msgs = await ghl.getConversationMessages(conversationId);
      return (Array.isArray(msgs) ? msgs : []).slice(0, 50).map(m => ({ direction: m.direction || '', type: m.messageType || m.type || '', body: m.body || '', dateAdded: m.dateAdded || '' }));
    },
  },

  // ---------- WRITE (confirmation-gated) ----------
  {
    name: 'bulk_update_contacts',
    write: true,
    description: `Update the SAME fields on MANY contacts at once (e.g. set the owner or source for a whole audience). ALWAYS use this instead of calling update_contact repeatedly when changing more than ~3 contacts — it processes in the background in chunks so it never times out, no matter how many contacts.
Targeting (pick ONE): tag (+ optional allTags), filters (advanced GoHighLevel filters — this is how you target a Smart List audience, same syntax as count_contacts), or contactIds for a short explicit list (under ~20). Do NOT call search_by_tag first; the dashboard resolves targets in the background.
To set the owner, pass {"assignedTo":"Kimberly"} — a name is resolved to the real user id and the job is REJECTED if the name is unknown, so it can never silently do nothing.
Set confirmed=true ONLY after the user approves.`,
    input_schema: {
      type: 'object',
      properties: {
        fields: { type: 'object', description: 'Fields to set on every matched contact, e.g. {"source":"Facebook - Food manufacturer"} or {"assignedTo":"Kimberly"}' },
        contactIds: { type: 'array', items: { type: 'string' }, description: 'Explicit contact ids to update (use this if you already have the list).' },
        tag: { type: 'string', description: 'Update all contacts that have this tag.' },
        allTags: { type: 'array', items: { type: 'string' }, description: 'Require ALL of these tags (AND filter). Include the primary tag here too.' },
        filters: { type: 'array', items: { type: 'object' }, description: 'Advanced GoHighLevel search filters defining the audience (verify with count_contacts first).' },
        query: { type: 'string', description: 'Optional free-text audience match.' },
        expectedTotal: { type: 'number', description: 'The count the user expects (e.g. 744). The job aborts if the audience does not match, so a wrong filter can never update the wrong people.' },
        confirmed: { type: 'boolean', description: 'Must be true to actually queue the job.' },
      },
      required: ['fields'],
    },
    async run(input) {
      return buildBulkJob('update_contact', input);
    },
  },
  {
    name: 'bulk_tag_contacts',
    write: true,
    description: 'Add or remove the SAME tag(s) on MANY contacts at once. Use instead of add_tags/remove_tags when affecting more than ~3 contacts — runs in the background in chunks so it never times out. mode is "add" or "remove". Target with contactIds, tag (+ optional allTags), or advanced filters. Set confirmed=true ONLY after the user approves.',
    input_schema: {
      type: 'object',
      properties: {
        mode: { type: 'string', description: '"add" or "remove"' },
        tags: { type: 'array', items: { type: 'string' }, description: 'The tag(s) to add or remove on every matched contact.' },
        contactIds: { type: 'array', items: { type: 'string' }, description: 'Explicit contact ids to act on.' },
        tag: { type: 'string', description: 'Match all contacts that have this tag.' },
        allTags: { type: 'array', items: { type: 'string' }, description: 'Require ALL of these tags (AND filter).' },
        filters: { type: 'array', items: { type: 'object' }, description: 'Advanced GoHighLevel search filters defining the audience.' },
        query: { type: 'string', description: 'Optional free-text audience match.' },
        expectedTotal: { type: 'number', description: 'The count the user expects; the job aborts if the audience does not match.' },
        confirmed: { type: 'boolean' },
      },
      required: ['mode', 'tags'],
    },
    async run(input) {
      return buildBulkJob(input.mode === 'remove' ? 'remove_tags' : 'add_tags', input);
    },
  },
  {
    name: 'add_tags',
    write: true,
    description: 'Add one or more tags to a contact. Set confirmed=true ONLY after the user has explicitly approved.',
    input_schema: {
      type: 'object',
      properties: {
        contactId: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        confirmed: { type: 'boolean', description: 'Must be true to actually apply.' },
      },
      required: ['contactId', 'tags'],
    },
    async run({ contactId, tags }) {
      await ghl.addTagsToContact(contactId, tags);
      return { ok: true, added: tags, contactId };
    },
  },
  {
    name: 'remove_tags',
    write: true,
    description: 'Remove one or more tags from a contact. Set confirmed=true ONLY after the user has explicitly approved.',
    input_schema: {
      type: 'object',
      properties: {
        contactId: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        confirmed: { type: 'boolean' },
      },
      required: ['contactId', 'tags'],
    },
    async run({ contactId, tags }) {
      await ghl.removeTagsFromContact(contactId, tags);
      return { ok: true, removed: tags, contactId };
    },
  },
  {
    name: 'update_contact',
    write: true,
    description: 'Update fields on a contact (e.g. source, firstName, lastName, companyName, phone, assignedTo). Set confirmed=true ONLY after the user approves.',
    input_schema: {
      type: 'object',
      properties: {
        contactId: { type: 'string' },
        fields: { type: 'object', description: 'Key/value fields to update, e.g. {"source":"Enterpryze"}' },
        confirmed: { type: 'boolean' },
      },
      required: ['contactId', 'fields'],
    },
    async run({ contactId, fields }) {
      await ghl.updateContact(contactId, fields);
      return { ok: true, contactId, updated: fields };
    },
  },
  {
    name: 'create_contact',
    write: true,
    description: 'Create a new contact. fields may include firstName, lastName, email, phone, companyName, address1, city, state, postalCode, website, source, tags (array), assignedTo. Set confirmed=true ONLY after the user approves.',
    input_schema: {
      type: 'object',
      properties: {
        fields: { type: 'object' },
        confirmed: { type: 'boolean' },
      },
      required: ['fields'],
    },
    async run({ fields }) {
      const created = await ghl.createContact(fields);
      return { ok: true, contact: contactSummary(created) };
    },
  },
  {
    name: 'create_opportunity',
    write: true,
    description: 'Create an opportunity in a pipeline stage for a contact. Needs pipelineId, pipelineStageId, name, contactId; optional assignedTo, monetaryValue. Set confirmed=true ONLY after the user approves.',
    input_schema: {
      type: 'object',
      properties: {
        pipelineId: { type: 'string' },
        pipelineStageId: { type: 'string' },
        name: { type: 'string' },
        contactId: { type: 'string' },
        assignedTo: { type: 'string' },
        monetaryValue: { type: 'number' },
        confirmed: { type: 'boolean' },
      },
      required: ['pipelineId', 'pipelineStageId', 'name', 'contactId'],
    },
    async run({ confirmed, ...fields }) {
      const opp = await ghl.createOpportunity({ status: 'open', ...fields });
      return { ok: true, opportunityId: opp.id, name: opp.name };
    },
  },
  {
    name: 'update_opportunity',
    write: true,
    description: 'Update an existing opportunity (e.g. name, pipelineStageId, status, source, monetaryValue). Always include pipelineId. Set confirmed=true ONLY after the user approves.',
    input_schema: {
      type: 'object',
      properties: {
        opportunityId: { type: 'string' },
        fields: { type: 'object', description: 'Fields to update; include pipelineId.' },
        confirmed: { type: 'boolean' },
      },
      required: ['opportunityId', 'fields'],
    },
    async run({ opportunityId, fields }) {
      await ghl.updateOpportunity(opportunityId, fields);
      return { ok: true, opportunityId, updated: fields };
    },
  },
  {
    name: 'delete_opportunity',
    write: true,
    description: 'Delete an opportunity by id (irreversible). Set confirmed=true ONLY after the user approves.',
    input_schema: {
      type: 'object',
      properties: {
        opportunityId: { type: 'string' },
        confirmed: { type: 'boolean' },
      },
      required: ['opportunityId'],
    },
    async run({ opportunityId }) {
      await ghl.deleteOpportunity(opportunityId);
      return { ok: true, deleted: opportunityId };
    },
  },
  {
    name: 'delete_contact',
    write: true,
    description: 'Delete a contact by id (irreversible; also removes their opportunities). Set confirmed=true ONLY after the user approves.',
    input_schema: {
      type: 'object',
      properties: {
        contactId: { type: 'string' },
        confirmed: { type: 'boolean' },
      },
      required: ['contactId'],
    },
    async run({ contactId }) {
      await ghl.deleteContact(contactId);
      return { ok: true, deleted: contactId };
    },
  },
  {
    name: 'add_to_workflow',
    write: true,
    description: 'Enroll a contact into an existing automation workflow (use list_workflows to get workflowId). This runs your pre-built automation. Set confirmed=true ONLY after the user approves.',
    input_schema: {
      type: 'object',
      properties: {
        contactId: { type: 'string' },
        workflowId: { type: 'string' },
        confirmed: { type: 'boolean' },
      },
      required: ['contactId', 'workflowId'],
    },
    async run({ contactId, workflowId }) {
      await ghl.addContactToWorkflow(contactId, workflowId);
      return { ok: true, contactId, workflowId, enrolled: true };
    },
  },
  {
    name: 'remove_from_workflow',
    write: true,
    description: 'Remove a contact from a workflow. Set confirmed=true ONLY after the user approves.',
    input_schema: {
      type: 'object',
      properties: {
        contactId: { type: 'string' },
        workflowId: { type: 'string' },
        confirmed: { type: 'boolean' },
      },
      required: ['contactId', 'workflowId'],
    },
    async run({ contactId, workflowId }) {
      await ghl.removeContactFromWorkflow(contactId, workflowId);
      return { ok: true, contactId, workflowId, removed: true };
    },
  },
  {
    name: 'add_note',
    write: true,
    description: 'Add a note to a contact. Set confirmed=true ONLY after the user approves.',
    input_schema: {
      type: 'object',
      properties: {
        contactId: { type: 'string' },
        body: { type: 'string' },
        confirmed: { type: 'boolean' },
      },
      required: ['contactId', 'body'],
    },
    async run({ contactId, body }) {
      await ghl.addNote(contactId, body);
      return { ok: true, contactId, note: body };
    },
  },
  {
    name: 'create_task',
    write: true,
    description: 'Create a task on a contact. fields: title (required), body, dueDate (ISO date), assignedTo (user id), completed. Set confirmed=true ONLY after the user approves.',
    input_schema: {
      type: 'object',
      properties: {
        contactId: { type: 'string' },
        fields: { type: 'object', description: 'e.g. {"title":"Call lead","dueDate":"2026-06-20T15:00:00Z","assignedTo":"<userId>"}' },
        confirmed: { type: 'boolean' },
      },
      required: ['contactId', 'fields'],
    },
    async run({ contactId, fields }) {
      const task = await ghl.createTask(contactId, fields);
      return { ok: true, contactId, taskId: task.id || null, fields };
    },
  },
  {
    name: 'update_task',
    write: true,
    description: 'Update a task on a contact (e.g. mark completed, change dueDate/title). Set confirmed=true ONLY after the user approves.',
    input_schema: {
      type: 'object',
      properties: {
        contactId: { type: 'string' },
        taskId: { type: 'string' },
        fields: { type: 'object' },
        confirmed: { type: 'boolean' },
      },
      required: ['contactId', 'taskId', 'fields'],
    },
    async run({ contactId, taskId, fields }) {
      await ghl.updateTask(contactId, taskId, fields);
      return { ok: true, contactId, taskId, updated: fields };
    },
  },
  {
    name: 'send_message',
    write: true,
    description: 'Send a message to a contact through GoHighLevel. For SMS: {type:"SMS", contactId, message}. For Email: {type:"Email", contactId, subject, message (or html)}. Set confirmed=true ONLY after the user approves.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'SMS or Email' },
        contactId: { type: 'string' },
        message: { type: 'string', description: 'Text body (SMS) or email plain body' },
        subject: { type: 'string', description: 'Email subject (Email only)' },
        html: { type: 'string', description: 'Optional HTML body (Email only)' },
        confirmed: { type: 'boolean' },
      },
      required: ['type', 'contactId'],
    },
    async run({ confirmed, ...fields }) {
      const result = await ghl.sendMessage(fields);
      return { ok: true, sent: fields.type, contactId: fields.contactId, result };
    },
  },
  {
    name: 'book_appointment',
    write: true,
    description: 'Book an appointment for a contact. Needs calendarId (use list_calendars), contactId, startTime and endTime (ISO 8601). Optional: title, assignedUserId, appointmentStatus. Set confirmed=true ONLY after the user approves.',
    input_schema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string' },
        contactId: { type: 'string' },
        startTime: { type: 'string' },
        endTime: { type: 'string' },
        title: { type: 'string' },
        assignedUserId: { type: 'string' },
        appointmentStatus: { type: 'string' },
        confirmed: { type: 'boolean' },
      },
      required: ['calendarId', 'contactId', 'startTime', 'endTime'],
    },
    async run({ confirmed, ...fields }) {
      const result = await ghl.createAppointment(fields);
      return { ok: true, appointmentId: result.id || (result.event && result.event.id) || null, result };
    },
  },
  {
    name: 'create_tag',
    write: true,
    description: 'Create a new tag at the location level. Set confirmed=true ONLY after the user approves.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        confirmed: { type: 'boolean' },
      },
      required: ['name'],
    },
    async run({ name }) {
      const result = await ghl.createLocationTag(name);
      return { ok: true, name, ...result };
    },
  },
];

const byName = Object.fromEntries(tools.map(t => [t.name, t]));

// Anthropic tool schema (strip our internal fields).
function anthropicTools() {
  return tools.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
}

// Execute a tool call. Write tools without confirmed===true return a preview
// instead of mutating, so the assistant can ask the user to confirm first.
async function runTool(name, input) {
  const tool = byName[name];
  if (!tool) return { error: `Unknown tool: ${name}` };
  try {
    if (tool.write && input.confirmed !== true) {
      // A bulk preview is vetted exactly like a real run, so the user is asked
      // to confirm the true audience size and the resolved owner — and an
      // impossible job is reported as an error instead of being confirmed.
      if (BULK_TOOL_OPS[name]) {
        const op = BULK_TOOL_OPS[name](input);
        const vetted = await vetBulkJob(op, input);
        if (vetted.error) return { error: vetted.error };
        return {
          preview: true,
          message: `CONFIRMATION REQUIRED. Not executed yet. This will ${describeBulkOp(op, input, vetted)} on ${vetted.total == null ? 'the matching' : vetted.total} contacts.`
            + (vetted.notes.length ? ` ${vetted.notes.join('; ')}.` : '')
            + ` State that exact count to the user and ask them to confirm; once they say yes, call ${name} again with confirmed=true.`,
          total: vetted.total,
          notes: vetted.notes.length ? vetted.notes : undefined,
          // Vetted spec so the dashboard can run the job the moment the user
          // confirms, without re-deriving it from the raw tool input.
          previewJob: vetted.job,
          proposed: input,
        };
      }
      return {
        preview: true,
        message: `CONFIRMATION REQUIRED. This is a write action (${name}) and was NOT executed. Show the user exactly what will change and ask them to confirm. Once they say yes, call ${name} again with confirmed=true.`,
        proposed: input,
      };
    }
    return await tool.run(input);
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
}

module.exports = { anthropicTools, runTool, tools, BULK_TOOL_OPS };
