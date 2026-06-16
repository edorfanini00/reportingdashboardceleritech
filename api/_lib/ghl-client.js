// GoHighLevel Contacts Search API client.
const GHL_API = 'https://services.leadconnectorhq.com/contacts/search';

function ghlConfigured() {
  const token = process.env.GHL_API_KEY || process.env.GHL_ACCESS_TOKEN;
  const locationId = process.env.GHL_LOCATION_ID;
  return Boolean(token && locationId);
}

function getCredentials() {
  return {
    token: process.env.GHL_API_KEY || process.env.GHL_ACCESS_TOKEN,
    locationId: process.env.GHL_LOCATION_ID,
  };
}

async function searchPage({ page, pageLimit, filters, searchAfter, query }) {
  const { token, locationId } = getCredentials();
  const body = { locationId, pageLimit };
  // searchAfter cursor paginates beyond the 10k page-based limit.
  if (searchAfter) body.searchAfter = searchAfter;
  else if (page) body.page = page;
  if (filters) body.filters = filters;
  if (query) body.query = query;

  const res = await fetch(GHL_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Version: '2021-07-28',
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GHL search failed (${res.status}): ${text.slice(0, 500)}`);
  }

  const data = await res.json();
  const batch = data.contacts || data.contact || data.data || [];
  const total = data.total != null ? data.total : (data.meta && data.meta.total);
  return { batch: Array.isArray(batch) ? batch : [], total };
}

// Tags to import. GHL's tag filter matches a whole tag (not a substring),
// so we list the exact tag names. Override with GHL_TAGS="a,b,c" in env.
function getQualifyingTagNames() {
  const fromEnv = process.env.GHL_TAGS;
  if (fromEnv) return fromEnv.split(',').map(t => t.trim()).filter(Boolean);
  return ['meta lead', 'meta lead fda', 'fda'];
}

// Page through a single exact-tag filter (results are small).
async function searchByTagEquals(tag, pageLimit = 100, maxPages = 50) {
  const all = [];
  let page = 1;
  for (let guard = 0; guard < maxPages; guard++) {
    const { batch } = await searchPage({
      page,
      pageLimit,
      filters: [{ field: 'tags', operator: 'eq', value: tag }],
    });
    all.push(...batch);
    if (batch.length < pageLimit) break;
    page += 1;
  }
  return all;
}

// Fetch contacts that have any qualifying tag (deduped by id).
async function fetchQualifyingContacts() {
  const byId = new Map();
  for (const tag of getQualifyingTagNames()) {
    const contacts = await searchByTagEquals(tag);
    for (const c of contacts) {
      const id = c.id || c.contactId || `${c.email || ''}-${c.phone || ''}`;
      byId.set(id, c);
    }
  }
  const contacts = [...byId.values()];
  return { contacts, total: contacts.length };
}

// Full scan (used only for diagnostics / debug).
async function fetchAllContacts(pageLimit = 100, maxPages = 500) {
  const all = [];
  let searchAfter = null;
  let total = null;
  for (let guard = 0; guard < maxPages; guard++) {
    const res = await searchPage(searchAfter ? { pageLimit, searchAfter } : { page: 1, pageLimit });
    if (total == null) total = res.total;
    if (!res.batch.length) break;
    all.push(...res.batch);
    const last = res.batch[res.batch.length - 1];
    const cursor = last && last.searchAfter;
    if (!cursor || res.batch.length < pageLimit) break;
    searchAfter = cursor;
  }
  return { contacts: all, total };
}

// Fetch custom-field definitions for the location → map of id -> { name, fieldKey }.
async function fetchCustomFieldMap() {
  const { token, locationId } = getCredentials();
  const url = `https://services.leadconnectorhq.com/locations/${locationId}/customFields`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Version: '2021-07-28',
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GHL customFields failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const list = data.customFields || data.customField || data.data || [];
  const map = {};
  for (const f of list) {
    if (!f || !f.id) continue;
    map[f.id] = { name: f.name || '', fieldKey: f.fieldKey || '' };
  }
  return map;
}

// --- Tagging / lookup helpers (used by scripts/tag-sentbyjhon.js) ---

const GHL_BASE = 'https://services.leadconnectorhq.com';

function authHeaders() {
  const { token } = getCredentials();
  return {
    Authorization: `Bearer ${token}`,
    Version: '2021-07-28',
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

// Keep only the last 10 digits so "+1 (555) 123-4567" matches "5551234567".
function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

// Create a tag at the location level. GHL also auto-creates tags when they are
// first applied to a contact, so this is best-effort and a 4xx "already exists"
// is treated as success.
async function createLocationTag(name) {
  const { locationId } = getCredentials();
  const res = await fetch(`${GHL_BASE}/locations/${locationId}/tags`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ name }),
  });
  if (res.ok) return { created: true };
  const text = await res.text();
  if (res.status === 400 || res.status === 409 || /exist/i.test(text)) {
    return { created: false, existed: true };
  }
  throw new Error(`GHL create tag failed (${res.status}): ${text.slice(0, 300)}`);
}

// Generic search returning up to `pageLimit` matches for a set of filters/query.
async function searchContacts({ filters, query, pageLimit = 20 }) {
  const { batch } = await searchPage({ page: 1, pageLimit, filters, query });
  return batch;
}

async function searchContactsByEmail(email) {
  if (!email) return [];
  return searchContacts({ filters: [{ field: 'email', operator: 'eq', value: String(email).toLowerCase() }] });
}

async function searchContactsByPhone(phone) {
  const norm = normalizePhone(phone);
  if (!norm) return [];
  // Free-text query is more forgiving of GHL's stored phone formatting than an
  // exact filter, so we query then confirm on the normalized last-10 digits.
  const results = await searchContacts({ query: norm });
  return results.filter(c => normalizePhone(c.phone) === norm);
}

async function searchContactsByName(name, company) {
  if (!name) return [];
  const results = await searchContacts({ query: String(name) });
  if (!company) return results;
  const wanted = String(company).toLowerCase().trim();
  const narrowed = results.filter(c => String(c.companyName || '').toLowerCase().includes(wanted));
  return narrowed.length ? narrowed : results;
}

// Create a new contact. `fields` may include firstName, lastName, email, phone,
// companyName, address1, city, state, postalCode, website, tags, source, assignedTo.
async function createContact(fields) {
  const { locationId } = getCredentials();
  const res = await fetch(`${GHL_BASE}/contacts/`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ locationId, ...fields }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GHL create contact failed (${res.status}): ${text.slice(0, 400)}`);
  let data = {};
  try { data = JSON.parse(text); } catch { /* noop */ }
  return data.contact || data;
}

// Add a free-text note to a contact (preserves John's original email detail).
async function addNote(contactId, body, userId) {
  const payload = { body };
  if (userId) payload.userId = userId;
  const res = await fetch(`${GHL_BASE}/contacts/${contactId}/notes`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GHL add note failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json().catch(() => ({}));
}

// Create an opportunity in a pipeline stage. `fields` needs pipelineId,
// pipelineStageId, name, contactId; optional status, assignedTo, monetaryValue.
async function createOpportunity(fields) {
  const { locationId } = getCredentials();
  const body = { locationId, status: 'open', ...fields };
  const res = await fetch(`${GHL_BASE}/opportunities/`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GHL create opportunity failed (${res.status}): ${text.slice(0, 400)}`);
  let data = {};
  try { data = JSON.parse(text); } catch { /* noop */ }
  return data.opportunity || data;
}

// Update fields on an existing opportunity (e.g. { name }). GHL expects the
// pipelineId in the update body.
async function updateOpportunity(opportunityId, fields) {
  const res = await fetch(`${GHL_BASE}/opportunities/${opportunityId}`, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify(fields),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GHL update opportunity failed (${res.status}): ${text.slice(0, 400)}`);
  try { return JSON.parse(text); } catch { return {}; }
}

// Update arbitrary fields on a contact (e.g. { source: 'Enterpryze' }).
async function updateContact(contactId, fields) {
  const res = await fetch(`${GHL_BASE}/contacts/${contactId}`, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify(fields),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GHL update contact failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json().catch(() => ({}));
}

// Add one or more tags to a contact (idempotent on GHL's side).
async function addTagsToContact(contactId, tags) {
  const list = Array.isArray(tags) ? tags : [tags];
  const res = await fetch(`${GHL_BASE}/contacts/${contactId}/tags`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ tags: list }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GHL add tag failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json().catch(() => ({}));
}

// Remove one or more tags from a contact.
async function removeTagsFromContact(contactId, tags) {
  const list = Array.isArray(tags) ? tags : [tags];
  const res = await fetch(`${GHL_BASE}/contacts/${contactId}/tags`, {
    method: 'DELETE',
    headers: authHeaders(),
    body: JSON.stringify({ tags: list }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GHL remove tag failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json().catch(() => ({}));
}

// Fetch a single contact by id.
async function getContact(contactId) {
  const res = await fetch(`${GHL_BASE}/contacts/${contactId}`, { headers: authHeaders() });
  const text = await res.text();
  if (!res.ok) throw new Error(`GHL get contact failed (${res.status}): ${text.slice(0, 300)}`);
  let data = {};
  try { data = JSON.parse(text); } catch { /* noop */ }
  return data.contact || data;
}

// Delete a contact by id (irreversible; also removes its opportunities).
async function deleteContact(contactId) {
  const res = await fetch(`${GHL_BASE}/contacts/${contactId}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GHL delete contact failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json().catch(() => ({}));
}

// List pipelines (with their stages).
async function listPipelines() {
  const { locationId } = getCredentials();
  const res = await fetch(`${GHL_BASE}/opportunities/pipelines?locationId=${locationId}`, { headers: authHeaders() });
  const text = await res.text();
  if (!res.ok) throw new Error(`GHL pipelines failed (${res.status}): ${text.slice(0, 300)}`);
  let data = {};
  try { data = JSON.parse(text); } catch { /* noop */ }
  return data.pipelines || data.data || [];
}

// List location users (id + name + email).
async function listUsers() {
  const { locationId } = getCredentials();
  const res = await fetch(`${GHL_BASE}/users/?locationId=${locationId}`, { headers: authHeaders() });
  const text = await res.text();
  if (!res.ok) throw new Error(`GHL users failed (${res.status}): ${text.slice(0, 300)}`);
  let data = {};
  try { data = JSON.parse(text); } catch { /* noop */ }
  return data.users || data.data || [];
}

// --- Workflows / automations ---

// List workflows built in the location (read-only; GHL has no create-workflow API).
async function listWorkflows() {
  const { locationId } = getCredentials();
  const res = await fetch(`${GHL_BASE}/workflows/?locationId=${locationId}`, { headers: authHeaders() });
  const text = await res.text();
  if (!res.ok) throw new Error(`GHL workflows failed (${res.status}): ${text.slice(0, 300)}`);
  let data = {};
  try { data = JSON.parse(text); } catch { /* noop */ }
  return data.workflows || data.data || [];
}

// Enroll a contact into an existing workflow (runs your pre-built automation).
async function addContactToWorkflow(contactId, workflowId, eventStartTime) {
  const body = eventStartTime ? { eventStartTime } : {};
  const res = await fetch(`${GHL_BASE}/contacts/${contactId}/workflow/${workflowId}`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GHL add to workflow failed (${res.status}): ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return {}; }
}

// Remove a contact from a workflow.
async function removeContactFromWorkflow(contactId, workflowId) {
  const res = await fetch(`${GHL_BASE}/contacts/${contactId}/workflow/${workflowId}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GHL remove from workflow failed (${res.status}): ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return {}; }
}

// --- Notes ---

// List notes on a contact.
async function getContactNotes(contactId) {
  const res = await fetch(`${GHL_BASE}/contacts/${contactId}/notes`, { headers: authHeaders() });
  const text = await res.text();
  if (!res.ok) throw new Error(`GHL get notes failed (${res.status}): ${text.slice(0, 300)}`);
  let data = {};
  try { data = JSON.parse(text); } catch { /* noop */ }
  return data.notes || data.data || [];
}

// --- Tasks ---

// List tasks on a contact.
async function getContactTasks(contactId) {
  const res = await fetch(`${GHL_BASE}/contacts/${contactId}/tasks`, { headers: authHeaders() });
  const text = await res.text();
  if (!res.ok) throw new Error(`GHL get tasks failed (${res.status}): ${text.slice(0, 300)}`);
  let data = {};
  try { data = JSON.parse(text); } catch { /* noop */ }
  return data.tasks || data.data || [];
}

// Create a task on a contact. fields: { title, body, dueDate, completed, assignedTo }.
async function createTask(contactId, fields) {
  const res = await fetch(`${GHL_BASE}/contacts/${contactId}/tasks`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(fields),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GHL create task failed (${res.status}): ${text.slice(0, 400)}`);
  let data = {};
  try { data = JSON.parse(text); } catch { /* noop */ }
  return data.task || data;
}

// Update a task (e.g. mark complete, change due date).
async function updateTask(contactId, taskId, fields) {
  const res = await fetch(`${GHL_BASE}/contacts/${contactId}/tasks/${taskId}`, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify(fields),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GHL update task failed (${res.status}): ${text.slice(0, 400)}`);
  try { return JSON.parse(text); } catch { return {}; }
}

// --- Opportunities (search / get / delete) ---

// Search opportunities. params: { query, pipelineId, pipelineStageId, contactId, assignedTo, status, limit }.
async function searchOpportunities(params = {}) {
  const { locationId } = getCredentials();
  const qs = new URLSearchParams({ location_id: locationId });
  if (params.query) qs.set('q', params.query);
  if (params.pipelineId) qs.set('pipeline_id', params.pipelineId);
  if (params.pipelineStageId) qs.set('pipeline_stage_id', params.pipelineStageId);
  if (params.contactId) qs.set('contact_id', params.contactId);
  if (params.assignedTo) qs.set('assigned_to', params.assignedTo);
  if (params.status) qs.set('status', params.status);
  qs.set('limit', String(params.limit || 20));
  const res = await fetch(`${GHL_BASE}/opportunities/search?${qs.toString()}`, { headers: authHeaders() });
  const text = await res.text();
  if (!res.ok) throw new Error(`GHL opp search failed (${res.status}): ${text.slice(0, 300)}`);
  let data = {};
  try { data = JSON.parse(text); } catch { /* noop */ }
  return data.opportunities || data.data || [];
}

// Get a single opportunity by id.
async function getOpportunity(opportunityId) {
  const res = await fetch(`${GHL_BASE}/opportunities/${opportunityId}`, { headers: authHeaders() });
  const text = await res.text();
  if (!res.ok) throw new Error(`GHL get opportunity failed (${res.status}): ${text.slice(0, 300)}`);
  let data = {};
  try { data = JSON.parse(text); } catch { /* noop */ }
  return data.opportunity || data;
}

// Delete an opportunity (irreversible).
async function deleteOpportunity(opportunityId) {
  const res = await fetch(`${GHL_BASE}/opportunities/${opportunityId}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GHL delete opportunity failed (${res.status}): ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return {}; }
}

// --- Conversations / messaging ---

// Send a message to a contact. type: "SMS" | "Email" | "WhatsApp" etc.
// For SMS: { type:'SMS', contactId, message }. For Email: add subject + (message|html).
async function sendMessage(fields) {
  const res = await fetch(`${GHL_BASE}/conversations/messages`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(fields),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GHL send message failed (${res.status}): ${text.slice(0, 400)}`);
  let data = {};
  try { data = JSON.parse(text); } catch { /* noop */ }
  return data;
}

// Search conversations (optionally for a contact).
async function searchConversations(params = {}) {
  const { locationId } = getCredentials();
  const qs = new URLSearchParams({ locationId });
  if (params.contactId) qs.set('contactId', params.contactId);
  if (params.query) qs.set('query', params.query);
  if (params.limit) qs.set('limit', String(params.limit));
  const res = await fetch(`${GHL_BASE}/conversations/search?${qs.toString()}`, { headers: authHeaders() });
  const text = await res.text();
  if (!res.ok) throw new Error(`GHL conversation search failed (${res.status}): ${text.slice(0, 300)}`);
  let data = {};
  try { data = JSON.parse(text); } catch { /* noop */ }
  return data.conversations || data.data || [];
}

// Get the messages in a conversation.
async function getConversationMessages(conversationId) {
  const res = await fetch(`${GHL_BASE}/conversations/${conversationId}/messages`, { headers: authHeaders() });
  const text = await res.text();
  if (!res.ok) throw new Error(`GHL get messages failed (${res.status}): ${text.slice(0, 300)}`);
  let data = {};
  try { data = JSON.parse(text); } catch { /* noop */ }
  return (data.messages && data.messages.messages) || data.messages || data.data || [];
}

// --- Calendars / appointments ---

// List calendars in the location.
async function listCalendars() {
  const { locationId } = getCredentials();
  const res = await fetch(`${GHL_BASE}/calendars/?locationId=${locationId}`, { headers: authHeaders() });
  const text = await res.text();
  if (!res.ok) throw new Error(`GHL calendars failed (${res.status}): ${text.slice(0, 300)}`);
  let data = {};
  try { data = JSON.parse(text); } catch { /* noop */ }
  return data.calendars || data.data || [];
}

// Book an appointment. fields: { calendarId, contactId, startTime, endTime, title, assignedUserId, appointmentStatus }.
async function createAppointment(fields) {
  const { locationId } = getCredentials();
  const res = await fetch(`${GHL_BASE}/calendars/events/appointments`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ locationId, ...fields }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GHL create appointment failed (${res.status}): ${text.slice(0, 400)}`);
  let data = {};
  try { data = JSON.parse(text); } catch { /* noop */ }
  return data;
}

// --- Location tags ---

// List all tags defined at the location level.
async function listLocationTags() {
  const { locationId } = getCredentials();
  const res = await fetch(`${GHL_BASE}/locations/${locationId}/tags`, { headers: authHeaders() });
  const text = await res.text();
  if (!res.ok) throw new Error(`GHL list tags failed (${res.status}): ${text.slice(0, 300)}`);
  let data = {};
  try { data = JSON.parse(text); } catch { /* noop */ }
  return data.tags || data.data || [];
}

// Build a frequency map of all tag names seen, preserving original casing.
function collectTagSamples(contacts) {
  const counts = {};
  for (const c of contacts) {
    const tags = Array.isArray(c.tags) ? c.tags : [];
    for (const t of tags) {
      const key = String(t);
      counts[key] = (counts[key] || 0) + 1;
    }
  }
  return counts;
}

module.exports = {
  ghlConfigured,
  getCredentials,
  fetchQualifyingContacts,
  fetchAllContacts,
  fetchCustomFieldMap,
  collectTagSamples,
  searchPage,
  searchContacts,
  searchContactsByEmail,
  searchContactsByPhone,
  searchContactsByName,
  createLocationTag,
  addTagsToContact,
  removeTagsFromContact,
  getContact,
  listPipelines,
  listUsers,
  updateContact,
  createContact,
  addNote,
  createOpportunity,
  updateOpportunity,
  deleteContact,
  searchByTagEquals,
  normalizePhone,
  listWorkflows,
  addContactToWorkflow,
  removeContactFromWorkflow,
  getContactNotes,
  getContactTasks,
  createTask,
  updateTask,
  searchOpportunities,
  getOpportunity,
  deleteOpportunity,
  sendMessage,
  searchConversations,
  getConversationMessages,
  listCalendars,
  createAppointment,
  listLocationTags,
};
