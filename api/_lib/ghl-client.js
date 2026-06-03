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

async function searchPage({ page, pageLimit, filters }) {
  const { token, locationId } = getCredentials();
  const body = { locationId, page, pageLimit };
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
  const nextPage = data.meta && data.meta.nextPage;
  return { batch: Array.isArray(batch) ? batch : [], nextPage };
}

// Fetch every contact in the location (paginated), no tag filter.
async function fetchAllContacts(pageLimit = 100, maxPages = 100) {
  const all = [];
  let page = 1;
  for (let guard = 0; guard < maxPages; guard++) {
    const { batch, nextPage } = await searchPage({ page, pageLimit });
    all.push(...batch);
    if (!batch.length || !nextPage) break;
    page = typeof nextPage === 'number' ? nextPage : page + 1;
  }
  return all;
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
