// Dashboard queue for leads John shared by email. Sync imports here (persisted
// in KV so they survive refreshes); Send pushes selected leads to GoHighLevel.
const { kv } = require('@vercel/kv');

const QUEUE_KEY = 'johnsync:queue';

const FREE_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
  'live.com', 'icloud.com', 'aol.com', 'protonmail.com', 'ymail.com', 'me.com',
]);

function leadKey(c) {
  return (c.email || c.phone || '').toLowerCase().trim();
}

function companyKey(c) {
  if (c.company) return c.company.toLowerCase().replace(/[^a-z0-9]/g, '');
  const domain = ((c.email || '').split('@')[1] || '').toLowerCase();
  if (domain && !FREE_DOMAINS.has(domain)) {
    const parts = domain.split('.');
    return parts.length > 1 ? parts.slice(0, -1).join('') : parts[0];
  }
  return leadKey(c);
}

// Build the stored shape, merging fresh extraction over an existing record while
// preserving user edits/overrides and status.
function normalizeLead(c, existing) {
  const key = leadKey(c);
  const now = new Date().toISOString();
  const fresh = {
    id: key,
    name: c.name || '',
    email: c.email || '',
    phone: c.phone || '',
    company: c.company || '',
    title: c.title || '',
    website: c.website || '',
    address1: c.address1 || '',
    city: c.city || '',
    state: c.state || '',
    postalCode: c.postalCode || '',
    notes: c.notes || '',
    companyKey: companyKey(c),
  };
  if (!existing) {
    return {
      ...fresh,
      status: 'pending',
      isNew: true,
      inCrm: false,
      pipelineId: null,
      stageId: null,
      assignedTo: null,
      discoveredAt: now,
      sentAt: null,
    };
  }
  // If the user manually edited this record, never overwrite — only backfill
  // blanks. Otherwise prefer the (improved) fresh extraction, falling back to
  // the stored value when fresh is empty.
  const pick = existing.edited
    ? (field) => existing[field] || fresh[field]
    : (field) => fresh[field] || existing[field];
  return {
    ...existing,
    name: pick('name'),
    phone: pick('phone'),
    company: pick('company'),
    title: pick('title'),
    website: pick('website'),
    address1: pick('address1'),
    city: pick('city'),
    state: pick('state'),
    postalCode: pick('postalCode'),
    notes: pick('notes'),
    companyKey: existing.companyKey || fresh.companyKey,
    isNew: false,
    discoveredAt: existing.discoveredAt || now,
  };
}

async function getMap() {
  return (await kv.hgetall(QUEUE_KEY)) || {};
}

async function getAll() {
  return Object.values(await getMap());
}

// Merge a fresh extraction into the queue. Existing leads are flagged isNew=false;
// genuinely new ones isNew=true so the UI can highlight what arrived this sync.
async function mergeCandidates(candidates, { legacySentKeys } = {}) {
  const map = await getMap();
  const addedKeys = [];
  // Reset isNew on everything already present.
  for (const k of Object.keys(map)) {
    if (map[k] && map[k].isNew) map[k] = { ...map[k], isNew: false };
  }
  for (const c of candidates) {
    const key = leadKey(c);
    if (!key) continue;
    const existing = map[key];
    if (!existing) addedKeys.push(key);
    map[key] = normalizeLead(c, existing);
    if (legacySentKeys && legacySentKeys.has(key) && map[key].status !== 'sent') {
      map[key] = { ...map[key], status: 'sent', isNew: false, sentAt: map[key].sentAt || legacySentKeys.get(key) || new Date().toISOString() };
    }
  }
  if (Object.keys(map).length) await kv.hset(QUEUE_KEY, map);
  return { added: addedKeys.length, addedKeys, total: Object.keys(map).length };
}

// Patch arbitrary fields on a queue item (user edits + pipeline/stage overrides).
async function updateLead(key, patch) {
  const map = await getMap();
  if (!map[key]) return null;
  const allowed = ['name', 'phone', 'company', 'title', 'website', 'address1', 'city', 'state', 'postalCode', 'notes', 'pipelineId', 'stageId', 'assignedTo'];
  const next = { ...map[key] };
  for (const f of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch, f)) next[f] = patch[f];
  }
  next.edited = true;
  map[key] = next;
  await kv.hset(QUEUE_KEY, { [key]: next });
  return next;
}

async function setInCrmFlags(flags) {
  const map = await getMap();
  let changed = false;
  for (const [key, val] of Object.entries(flags)) {
    if (map[key] && map[key].inCrm !== val) { map[key] = { ...map[key], inCrm: val }; changed = true; }
  }
  if (changed) await kv.hset(QUEUE_KEY, map);
}

// Remove phone-only (no-email) entries — these were noise from random numbers.
async function pruneNoEmail() {
  const map = await getMap();
  const drop = Object.values(map).filter(l => !l.email).map(l => l.id);
  if (drop.length) await kv.hdel(QUEUE_KEY, ...drop);
  return drop.length;
}

async function markSent(keys) {
  const map = await getMap();
  const now = new Date().toISOString();
  const patch = {};
  for (const key of keys) {
    if (map[key]) patch[key] = { ...map[key], status: 'sent', isNew: false, sentAt: now };
  }
  if (Object.keys(patch).length) await kv.hset(QUEUE_KEY, patch);
}

// Flag pending leads that share a company so the UI can warn about duplicates.
function annotateDuplicates(leads) {
  const byCompany = new Map();
  for (const l of leads) {
    if (l.status !== 'pending' || !l.companyKey) continue;
    if (!byCompany.has(l.companyKey)) byCompany.set(l.companyKey, []);
    byCompany.get(l.companyKey).push(l.id);
  }
  const dupKeys = new Set();
  for (const ids of byCompany.values()) {
    if (ids.length > 1) ids.forEach(id => dupKeys.add(id));
  }
  return leads.map(l => ({
    ...l,
    sameCompanyCount: l.companyKey ? (byCompany.get(l.companyKey) || []).length : 1,
    isDuplicateCompany: dupKeys.has(l.id),
  }));
}

module.exports = {
  QUEUE_KEY,
  leadKey,
  companyKey,
  getAll,
  getMap,
  mergeCandidates,
  updateLead,
  setInCrmFlags,
  pruneNoEmail,
  markSent,
  annotateDuplicates,
};
