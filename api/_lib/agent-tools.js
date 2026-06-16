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

  // ---------- READ (extended) ----------
  {
    name: 'list_workflows',
    write: false,
    description: 'List existing GoHighLevel workflows (automations) with id, name, status. Note: the API can enroll/remove contacts into these but CANNOT create or edit the workflows themselves (that is done in the GHL dashboard).',
    input_schema: { type: 'object', properties: {} },
    async run() {
      const wfs = await ghl.listWorkflows();
      return wfs.map(w => ({ id: w.id, name: w.name, status: w.status }));
    },
  },
  {
    name: 'list_notes',
    write: false,
    description: 'List notes on a contact.',
    input_schema: { type: 'object', properties: { contactId: { type: 'string' } }, required: ['contactId'] },
    async run({ contactId }) {
      const notes = await ghl.listNotes(contactId);
      return notes.map(n => ({ id: n.id, body: n.body, createdAt: n.dateAdded || n.createdAt }));
    },
  },
  {
    name: 'list_tasks',
    write: false,
    description: 'List tasks on a contact.',
    input_schema: { type: 'object', properties: { contactId: { type: 'string' } }, required: ['contactId'] },
    async run({ contactId }) {
      const tasks = await ghl.listTasks(contactId);
      return tasks.map(t => ({ id: t.id, title: t.title, body: t.body, dueDate: t.dueDate, completed: t.completed, assignedTo: t.assignedTo }));
    },
  },
  {
    name: 'search_opportunities',
    write: false,
    description: 'Search opportunities. Filter by query, pipelineId, pipelineStageId, contactId, status (open/won/lost/abandoned), assignedTo.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        pipelineId: { type: 'string' },
        pipelineStageId: { type: 'string' },
        contactId: { type: 'string' },
        status: { type: 'string' },
        assignedTo: { type: 'string' },
      },
    },
    async run(params) {
      const opps = await ghl.searchOpportunities(params);
      return opps.map(o => ({ id: o.id, name: o.name, status: o.status, pipelineId: o.pipelineId, stageId: o.pipelineStageId, monetaryValue: o.monetaryValue, contactId: (o.contact && o.contact.id) || o.contactId, assignedTo: o.assignedTo }));
    },
  },
  {
    name: 'get_opportunity',
    write: false,
    description: 'Get full details for a single opportunity by id.',
    input_schema: { type: 'object', properties: { opportunityId: { type: 'string' } }, required: ['opportunityId'] },
    async run({ opportunityId }) {
      return ghl.getOpportunity(opportunityId);
    },
  },
  {
    name: 'list_calendars',
    write: false,
    description: 'List the location calendars (id, name).',
    input_schema: { type: 'object', properties: {} },
    async run() {
      const cals = await ghl.listCalendars();
      return cals.map(c => ({ id: c.id, name: c.name }));
    },
  },
  {
    name: 'list_appointments',
    write: false,
    description: 'List appointments/events for a contact.',
    input_schema: { type: 'object', properties: { contactId: { type: 'string' } }, required: ['contactId'] },
    async run({ contactId }) {
      return ghl.listAppointments(contactId);
    },
  },
  {
    name: 'search_conversations',
    write: false,
    description: 'Search conversations (optionally for a specific contactId or free-text query).',
    input_schema: {
      type: 'object',
      properties: { contactId: { type: 'string' }, query: { type: 'string' } },
    },
    async run(params) {
      const convos = await ghl.searchConversations(params);
      return convos.map(c => ({ id: c.id, contactId: c.contactId, lastMessageBody: c.lastMessageBody, type: c.type, unreadCount: c.unreadCount }));
    },
  },
  {
    name: 'list_custom_fields',
    write: false,
    description: 'List the location custom field definitions (id, name, fieldKey, dataType, options). Use to find the right fieldKey/id before updating a custom field on a contact.',
    input_schema: { type: 'object', properties: {} },
    async run() {
      const fields = await ghl.listCustomFields();
      return fields.map(f => ({ id: f.id, name: f.name, fieldKey: f.fieldKey, dataType: f.dataType, options: f.picklistOptions || f.options }));
    },
  },
  {
    name: 'list_tags',
    write: false,
    description: 'List all tags defined at the location.',
    input_schema: { type: 'object', properties: {} },
    async run() {
      const tags = await ghl.listLocationTags();
      return tags.map(t => ({ id: t.id, name: t.name }));
    },
  },

  // ---------- WRITE (extended, confirmation-gated) ----------
  {
    name: 'add_to_workflow',
    write: true,
    description: 'Enroll a contact into an existing workflow (this triggers your pre-built automation). Use list_workflows to find workflowId. Set confirmed=true ONLY after the user approves.',
    input_schema: {
      type: 'object',
      properties: {
        contactId: { type: 'string' },
        workflowId: { type: 'string' },
        eventStartTime: { type: 'string', description: 'Optional ISO time to start the workflow.' },
        confirmed: { type: 'boolean' },
      },
      required: ['contactId', 'workflowId'],
    },
    async run({ contactId, workflowId, eventStartTime }) {
      await ghl.addContactToWorkflow(contactId, workflowId, eventStartTime);
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
      return { ok: true, contactId, added: 'note' };
    },
  },
  {
    name: 'update_note',
    write: true,
    description: 'Update an existing note on a contact. Set confirmed=true ONLY after the user approves.',
    input_schema: {
      type: 'object',
      properties: {
        contactId: { type: 'string' },
        noteId: { type: 'string' },
        body: { type: 'string' },
        confirmed: { type: 'boolean' },
      },
      required: ['contactId', 'noteId', 'body'],
    },
    async run({ contactId, noteId, body }) {
      await ghl.updateNote(contactId, noteId, body);
      return { ok: true, contactId, noteId, updated: true };
    },
  },
  {
    name: 'delete_note',
    write: true,
    description: 'Delete a note from a contact. Set confirmed=true ONLY after the user approves.',
    input_schema: {
      type: 'object',
      properties: {
        contactId: { type: 'string' },
        noteId: { type: 'string' },
        confirmed: { type: 'boolean' },
      },
      required: ['contactId', 'noteId'],
    },
    async run({ contactId, noteId }) {
      await ghl.deleteNote(contactId, noteId);
      return { ok: true, contactId, noteId, deleted: true };
    },
  },
  {
    name: 'create_task',
    write: true,
    description: 'Create a task for a contact. fields: title (required), body, dueDate (ISO), completed (bool), assignedTo (userId). Set confirmed=true ONLY after the user approves.',
    input_schema: {
      type: 'object',
      properties: {
        contactId: { type: 'string' },
        fields: { type: 'object' },
        confirmed: { type: 'boolean' },
      },
      required: ['contactId', 'fields'],
    },
    async run({ contactId, fields }) {
      const task = await ghl.createTask(contactId, fields);
      return { ok: true, contactId, taskId: task.id || null };
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
    name: 'delete_task',
    write: true,
    description: 'Delete a task from a contact. Set confirmed=true ONLY after the user approves.',
    input_schema: {
      type: 'object',
      properties: {
        contactId: { type: 'string' },
        taskId: { type: 'string' },
        confirmed: { type: 'boolean' },
      },
      required: ['contactId', 'taskId'],
    },
    async run({ contactId, taskId }) {
      await ghl.deleteTask(contactId, taskId);
      return { ok: true, contactId, taskId, deleted: true };
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
      return { ok: true, opportunityId, deleted: true };
    },
  },
  {
    name: 'delete_contact',
    write: true,
    description: 'Delete a contact by id (IRREVERSIBLE; also removes their opportunities). Be extra cautious and make the user confirm explicitly. Set confirmed=true ONLY after the user approves.',
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
      return { ok: true, contactId, deleted: true };
    },
  },
  {
    name: 'send_message',
    write: true,
    description: 'Send an outbound message to a contact via GoHighLevel. fields: type ("SMS" or "Email"), contactId, message (SMS body or email text); for Email also subject and optionally html. Requires the contact to have a valid phone (SMS) or email (Email) and a configured sending channel. Set confirmed=true ONLY after the user approves.',
    input_schema: {
      type: 'object',
      properties: {
        fields: { type: 'object' },
        confirmed: { type: 'boolean' },
      },
      required: ['fields'],
    },
    async run({ fields }) {
      const result = await ghl.sendMessage(fields);
      return { ok: true, messageId: result.messageId || result.id || null, type: fields.type };
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
