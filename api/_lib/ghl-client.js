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

// Fetch every contact in the location using searchAfter cursor pagination.
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

module.exports = { ghlConfigured, fetchAllContacts, collectTagSamples, searchPage };
