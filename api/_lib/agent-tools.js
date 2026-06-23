// Tool registry for the GoHighLevel AI assistant.
// Each tool has: name, description, input_schema (Anthropic format), write flag,
// and a run(input) executor. Write tools only mutate when input.confirmed===true;
// otherwise they return a preview so the assistant can ask the user to confirm.

const ghl = require('./ghl-client');
const bulk = require('./bulk');

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
    description: 'Find ALL contacts that have a specific tag (paginates through every result, not limited to 20). If multiple tags are provided, returns only contacts that have ALL of them (AND logic). Much more reliable than search_contacts for tag-based queries.',
    input_schema: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: 'Exact tag name to search for (primary tag to paginate through)' },
        allTags: { type: 'array', items: { type: 'string' }, description: 'Optional: list of ALL tags the contacts must have (AND filter applied after fetching). Include the primary tag here too.' },
      },
      required: ['tag'],
    },
    async run({ tag, allTags }) {
      let results = await ghl.searchByTagEquals(tag);
      if (Array.isArray(allTags) && allTags.length > 1) {
        const required = allTags.map(t => t.toLowerCase());
        results = results.filter(c => {
          const cTags = (c.tags || []).map(t => t.toLowerCase());
          return required.every(r => cTags.includes(r));
        });
      }
      return { count: results.length, contacts: results.map(contactSummary) };
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
    description: 'Update the SAME fields on MANY contacts at once (e.g. set source for every contact with a tag). ALWAYS use this instead of calling update_contact repeatedly when changing more than ~3 contacts — it processes in the background in chunks so it never times out, no matter how many contacts. Provide EITHER contactIds (explicit list) OR tag (+ optional allTags for AND filtering). Set confirmed=true ONLY after the user approves.',
    input_schema: {
      type: 'object',
      properties: {
        fields: { type: 'object', description: 'Fields to set on every matched contact, e.g. {"source":"Facebook - Food manufacturer"}' },
        contactIds: { type: 'array', items: { type: 'string' }, description: 'Explicit contact ids to update (use this if you already have the list).' },
        tag: { type: 'string', description: 'Update all contacts that have this tag.' },
        allTags: { type: 'array', items: { type: 'string' }, description: 'Require ALL of these tags (AND filter). Include the primary tag here too.' },
        confirmed: { type: 'boolean', description: 'Must be true to actually queue the job.' },
      },
      required: ['fields'],
    },
    async run({ fields, contactIds, tag, allTags }) {
      const job = await bulk.createBulkJob({ op: 'update_contact', fields, contactIds, tag, allTags });
      const count = job.total == null ? 'the matching' : job.total;
      return {
        ok: true,
        bulk: true,
        bulkJobId: job.id,
        op: 'update_contact',
        total: job.total,
        message: job.total === 0
          ? 'No matching contacts found, nothing to update.'
          : `Queued an update for ${count} contacts. The dashboard is now processing them automatically and showing live progress — no need to verify each one.`,
      };
    },
  },
  {
    name: 'bulk_tag_contacts',
    write: true,
    description: 'Add or remove the SAME tag(s) on MANY contacts at once. Use instead of add_tags/remove_tags when affecting more than ~3 contacts — runs in the background in chunks so it never times out. mode is "add" or "remove". Provide EITHER contactIds OR tag (+ optional allTags filter). Set confirmed=true ONLY after the user approves.',
    input_schema: {
      type: 'object',
      properties: {
        mode: { type: 'string', description: '"add" or "remove"' },
        tags: { type: 'array', items: { type: 'string' }, description: 'The tag(s) to add or remove on every matched contact.' },
        contactIds: { type: 'array', items: { type: 'string' }, description: 'Explicit contact ids to act on.' },
        tag: { type: 'string', description: 'Match all contacts that have this tag.' },
        allTags: { type: 'array', items: { type: 'string' }, description: 'Require ALL of these tags (AND filter).' },
        confirmed: { type: 'boolean' },
      },
      required: ['mode', 'tags'],
    },
    async run({ mode, tags, contactIds, tag, allTags }) {
      const op = mode === 'remove' ? 'remove_tags' : 'add_tags';
      const job = await bulk.createBulkJob({ op, tags, contactIds, tag, allTags });
      const count = job.total == null ? 'the matching' : job.total;
      return {
        ok: true,
        bulk: true,
        bulkJobId: job.id,
        op,
        total: job.total,
        message: job.total === 0
          ? 'No matching contacts found, nothing to change.'
          : `Queued ${mode === 'remove' ? 'removal' : 'addition'} of tag(s) on ${count} contacts. The dashboard is now processing them automatically and showing live progress.`,
      };
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

module.exports = { anthropicTools, runTool, tools };
