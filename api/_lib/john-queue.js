// Dashboard queue for leads John shared by email. Sync imports here; Send pushes
// selected leads to GoHighLevel.
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

function normalizeLead(c, existing) {
  const key = leadKey(c);
  const now = new Date().toISOString();
  const base = {
    id: key,
    name: c.name || '',
    email: c.email || '',
    phone: c.phone || '',
    company: c.company || '',
    companyKey: companyKey(c),
    status: 'pending',
    discoveredAt: now,
    sentAt: null,
    source: c.source || null,
  };
  if (existing) {
    return {
      ...existing,
      name: existing.name || base.name,
      phone: existing.phone || base.phone,
      company: existing.company || base.company,
      companyKey: existing.companyKey || base.companyKey,
      source: existing.source || base.source,
      // Keep sent status once uploaded.
      status: existing.status === 'sent' ? 'sent' : 'pending',
      discoveredAt: existing.discoveredAt || base.discoveredAt,
    };
  }
  return base;
}

async function getAll() {
  const raw = (await kv.hgetall(QUEUE_KEY)) || {};
  return Object.values(raw);
}

async function getMap() {
  return (await kv.hgetall(QUEUE_KEY)) || {};
}

async function mergeCandidates(candidates, { legacySentKeys } = {}) {
  const map = await getMap();
  let added = 0;
  for (const c of candidates) {
    const key = leadKey(c);
    if (!key) continue;
    const existing = map[key];
    if (!existing) added++;
    map[key] = normalizeLead(c, existing);
    if (legacySentKeys && legacySentKeys.has(key) && map[key].status !== 'sent') {
      map[key] = { ...map[key], status: 'sent', sentAt: map[key].sentAt || legacySentKeys.get(key) || new Date().toISOString() };
    }
  }
  if (Object.keys(map).length) await kv.hset(QUEUE_KEY, map);
  return { added, total: Object.keys(map).length };
}

async function markSent(keys) {
  const map = await getMap();
  const now = new Date().toISOString();
  for (const key of keys) {
    if (map[key]) {
      map[key] = { ...map[key], status: 'sent', sentAt: now };
    }
  }
  if (Object.keys(map).length) await kv.hset(QUEUE_KEY, map);
}

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
  markSent,
  annotateDuplicates,
};
