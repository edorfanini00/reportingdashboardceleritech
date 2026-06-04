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

async function searchPage({ page, pageLimit, filters, searchAfter }) {
  const { token, locationId } = getCredentials();
  const body = { locationId, pageLimit };
  // searchAfter cursor paginates beyond the 10k page-based limit.
  if (searchAfter) body.searchAfter = searchAfter;
  else if (page) body.page = page;
  if (filters) body.filters = filters;

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

module.exports = { ghlConfigured, fetchQualifyingContacts, fetchAllContacts, fetchCustomFieldMap, collectTagSamples, searchPage };
