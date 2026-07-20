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

// Read the whole hash once (1 Redis command) as an id -> lead map.
async function getAllLeadsMap() {
  const all = await kv.hgetall(HASH_KEY);
  return all || {};
}

// Bulk save: applies the sticky booked/attended merge against a pre-fetched
// existing map, skips unchanged leads, and writes the rest in a few large
// hset calls. Replaces the per-lead hget+hset pattern that cost 2 Redis
// commands per contact per sync and exhausted the KV free-tier quota.
async function saveLeadsBulk(leads, existingMap) {
  const toWrite = {};
  let unchanged = 0;
  for (const lead of leads) {
    const existing = existingMap ? existingMap[lead.id] : null;
    if (existing) {
      if (existing.meetingBooked && !lead.meetingBooked) lead.meetingBooked = true;
      if (existing.meetingAttended && !lead.meetingAttended) lead.meetingAttended = true;
      if (JSON.stringify(existing) === JSON.stringify(lead)) { unchanged++; continue; }
    }
    toWrite[lead.id] = lead;
  }
  const ids = Object.keys(toWrite);
  // Chunk so a single request never approaches Upstash's request-size limit.
  const CHUNK = 50;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = {};
    for (const id of ids.slice(i, i + CHUNK)) slice[id] = toWrite[id];
    await kv.hset(HASH_KEY, slice);
  }
  return { written: ids.length, unchanged };
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

module.exports = { saveLead, saveLeadsBulk, getAllLeads, getAllLeadsMap, deleteLead, isConfigured, HASH_KEY };
