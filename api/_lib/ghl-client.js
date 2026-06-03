// GoHighLevel Contacts Search API — paginated fetch by tag.
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

async function searchContactsByTag(tag, pageLimit = 100) {
  const { token, locationId } = getCredentials();
  const contacts = [];
  let page = 1;

  for (let guard = 0; guard < 200; guard++) {
    const res = await fetch(GHL_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Version: '2021-07-28',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        locationId,
        page,
        pageLimit,
        filters: [{ field: 'tags', operator: 'eq', value: tag }],
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GHL search failed (${res.status}): ${text.slice(0, 500)}`);
    }

    const data = await res.json();
    const batch = data.contacts || data.contact || data.data || [];
    if (Array.isArray(batch)) contacts.push(...batch);

    const nextPage = data.meta && data.meta.nextPage;
    if (!nextPage || !batch.length) break;
    page = typeof nextPage === 'number' ? nextPage : page + 1;
  }

  return contacts;
}

/** Fetch all contacts tagged "meta" or "meta fda" (deduped by id). */
async function fetchAllQualifyingContacts() {
  const byId = new Map();
  for (const tag of ['meta', 'meta fda']) {
    const batch = await searchContactsByTag(tag);
    for (const c of batch) {
      const id = c.id || c.contactId;
      if (id) byId.set(id, c);
      else byId.set(`${c.email || ''}-${c.phone || ''}`, c);
    }
  }
  return [...byId.values()];
}

module.exports = { ghlConfigured, fetchAllQualifyingContacts, searchContactsByTag };
