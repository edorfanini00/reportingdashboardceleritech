// Tool registry for the GoHighLevel AI assistant.
// Each tool has: name, description, input_schema (Anthropic format), write flag,
// and a run(input) executor. Write tools only mutate when input.confirmed===true;
// otherwise they return a preview so the assistant can ask the user to confirm.

const ghl = require('./ghl-client');

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

  // ---------- WRITE (confirmation-gated) ----------
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
