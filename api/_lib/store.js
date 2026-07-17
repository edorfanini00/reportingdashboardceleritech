// Thin storage wrapper around Vercel KV. Leads are stored in a single hash
// keyed by contact id so re-tagging the same contact updates rather than dupes.
const { kv } = require('@vercel/kv');

const HASH_KEY = 'ghl:leads';

function isConfigured() {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

async function saveLead(lead) {
  // Booked/attended are sticky: once a lead was marked booked (via the Status
  // field, a tag, or manually) a later re-sync without that signal must not
  // un-book it.
  try {
    const existing = await kv.hget(HASH_KEY, lead.id);
    if (existing) {
      if (existing.meetingBooked && !lead.meetingBooked) lead.meetingBooked = true;
      if (existing.meetingAttended && !lead.meetingAttended) lead.meetingAttended = true;
    }
  } catch { /* best effort: fall through and save as-is */ }
  await kv.hset(HASH_KEY, { [lead.id]: lead });
}

async function getAllLeads() {
  const all = await kv.hgetall(HASH_KEY);
  if (!all) return [];
  // @vercel/kv auto-deserializes JSON values.
  return Object.values(all);
}

async function deleteLead(id) {
  await kv.hdel(HASH_KEY, id);
}

module.exports = { saveLead, getAllLeads, deleteLead, isConfigured, HASH_KEY };
