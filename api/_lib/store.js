// Thin storage wrapper around Vercel KV. Leads are stored in a single hash
// keyed by contact id so re-tagging the same contact updates rather than dupes.
const { kv } = require('@vercel/kv');

const HASH_KEY = 'ghl:leads';

function isConfigured() {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

async function saveLead(lead) {
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

const FIELDMAP_KEY = 'ghl:fieldmap';

async function saveFieldMap(map) {
  await kv.set(FIELDMAP_KEY, map);
}

async function getFieldMap() {
  const map = await kv.get(FIELDMAP_KEY);
  return map && typeof map === 'object' ? map : {};
}

module.exports = { saveLead, getAllLeads, deleteLead, saveFieldMap, getFieldMap, isConfigured, HASH_KEY };
