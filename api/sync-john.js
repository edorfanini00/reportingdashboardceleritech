// John lead workflow:
//   GET  — list dashboard queue (optionally ?refresh=1 to scan emails first)
//   POST { action: 'sync' } — scan John's emails → import new leads into queue
//   POST { action: 'send', keys: [...] } — upload selected leads to GoHighLevel
const ghl = require('./_lib/ghl-client');
const { getAccessToken, fetchMessagesFromSender } = require('./_lib/ms-graph');
const { extractFromMessages, emailVariants } = require('./_lib/extract');
const johnQueue = require('./_lib/john-queue');

const PIPELINE_ID = process.env.ENTERPRYZE_PIPELINE_ID || 'FGMXcH1ZySUFZSmV2R00';
const STAGE_ID = process.env.ERP_QUALIFIED_STAGE_ID || '60a21606-5d7e-402f-85ac-74cde9e57f2f';
const NATALIE_ID = process.env.NATALIE_USER_ID || '4J8l9pZV4WcpYyqtpkj7';
const TAG = process.env.SENT_TAG || 'sentbyjhon';
const SOURCE = process.env.CONTACT_SOURCE || 'Enterpryze';
const EXCLUDE_DOMAINS = (process.env.EXCLUDE_DOMAINS || 'celeritech.biz,enterpryze.com')
  .split(',').map(d => d.trim().toLowerCase()).filter(Boolean);

function isExcluded(c) {
  const domain = (c.email || '').split('@')[1] || '';
  return EXCLUDE_DOMAINS.includes(domain.toLowerCase());
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

async function matchContact(c) {
  if (c.email) {
    const byEmail = await ghl.searchContactsByEmail(c.email);
    if (byEmail.length) return byEmail[0];
    for (const v of emailVariants(c.email)) {
      const hit = await ghl.searchContactsByEmail(v);
      if (hit.length) return hit[0];
    }
  }
  if (c.phone) {
    const byPhone = await ghl.searchContactsByPhone(c.phone);
    if (byPhone.length) return byPhone[0];
  }
  return null;
}

async function scanEmails() {
  const token = await getAccessToken();
  const messages = await fetchMessagesFromSender(token, process.env.JOHN_EMAIL, { max: 2000 });
  const all = extractFromMessages(messages);
  const candidates = all.filter(c => !isExcluded(c));
  // One-time carry-over: leads auto-synced before the review queue existed.
  let legacySentKeys = null;
  try {
    const { kv } = require('@vercel/kv');
    const old = (await kv.hgetall('johnsync:processed')) || {};
    if (Object.keys(old).length) {
      legacySentKeys = new Map(Object.entries(old));
    }
  } catch { /* optional */ }
  const { added, total } = await johnQueue.mergeCandidates(candidates, { legacySentKeys });
  return { fetchedEmails: messages.length, candidates: candidates.length, skippedInternal: all.length - candidates.length, added, total };
}

async function enrichInCrm(leads) {
  const out = [];
  for (const l of leads) {
    let inCrm = false;
    if (l.status === 'pending') {
      try { inCrm = !!(await matchContact(l)); } catch { /* best-effort */ }
    }
    out.push({ ...l, inCrm });
  }
  return out;
}

function buildListResponse(scan, leads) {
  const pending = leads.filter(l => l.status === 'pending');
  const sent = leads.filter(l => l.status === 'sent');
  return {
    ok: true,
    fetchedEmails: scan?.fetchedEmails ?? null,
    candidates: scan?.candidates ?? leads.length,
    skippedInternal: scan?.skippedInternal ?? 0,
    added: scan?.added ?? 0,
    pending: pending.length,
    sent: sent.length,
    total: leads.length,
    newLeads: pending.length,
    leads: leads.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'pending' ? -1 : 1;
      if (a.isDuplicateCompany !== b.isDuplicateCompany) return a.isDuplicateCompany ? -1 : 1;
      return (a.company || a.email).localeCompare(b.company || b.email);
    }),
  };
}

async function handleList(refresh) {
  let scan = null;
  if (refresh) scan = await scanEmails();
  let leads = johnQueue.annotateDuplicates(await johnQueue.getAll());
  leads = await enrichInCrm(leads);
  return buildListResponse(scan, leads);
}

async function handleSync() {
  const scan = await scanEmails();
  let leads = johnQueue.annotateDuplicates(await johnQueue.getAll());
  leads = await enrichInCrm(leads);
  return buildListResponse(scan, leads);
}

async function handleSend(keys) {
  if (!Array.isArray(keys) || !keys.length) {
    throw new Error('No leads selected.');
  }
  await ghl.createLocationTag(TAG).catch(() => {});

  const map = await johnQueue.getMap();
  const summary = { tagged: 0, created: 0, opportunities: 0, sent: 0, errors: [] };

  const sentKeys = [];

  for (const key of keys) {
    const c = map[key];
    if (!c || c.status === 'sent') continue;
    try {
      const match = await matchContact(c);
      if (match) {
        await ghl.addTagsToContact(match.id, [TAG]);
        await ghl.updateContact(match.id, { source: SOURCE });
        summary.tagged++;
      } else {
        const [firstName, ...rest] = (c.name || '').split(' ');
        const created = await ghl.createContact({
          firstName: firstName || undefined,
          lastName: rest.join(' ') || undefined,
          email: c.email || undefined,
          phone: c.phone || undefined,
          companyName: c.company || undefined,
          source: SOURCE,
          tags: [TAG],
          assignedTo: NATALIE_ID,
        });
        const contactId = created.id || (created.contact && created.contact.id);
        summary.created++;
        if (contactId) {
          await ghl.createOpportunity({
            pipelineId: PIPELINE_ID,
            pipelineStageId: STAGE_ID,
            name: c.company || c.name || c.email || 'New Lead',
            contactId,
            assignedTo: NATALIE_ID,
            status: 'open',
          });
          summary.opportunities++;
        }
      }
      summary.sent++;
      sentKeys.push(key);
    } catch (err) {
      summary.errors.push({ key, error: String((err && err.message) || err) });
    }
  }

  if (sentKeys.length) await johnQueue.markSent(sentKeys);

  let leads = johnQueue.annotateDuplicates(await johnQueue.getAll());
  leads = await enrichInCrm(leads);
  return { ok: true, ...summary, ...buildListResponse(null, leads) };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.JOHN_EMAIL) { res.status(500).json({ ok: false, error: 'JOHN_EMAIL not set.' }); return; }
  if (!process.env.KV_REST_API_URL) { res.status(500).json({ ok: false, error: 'KV not configured.' }); return; }

  try {
    if (req.method === 'GET') {
      const refresh = String((req.query && req.query.refresh) || '') === '1'
        || String((req.query && req.query.preview) || '') === '1';
      res.status(200).json(await handleList(refresh));
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'Use GET or POST' });
      return;
    }

    if (!ghl.ghlConfigured()) { res.status(500).json({ ok: false, error: 'GoHighLevel not configured.' }); return; }

    const body = await readBody(req);
    const action = body.action || 'sync';

    if (action === 'send') {
      res.status(200).json(await handleSend(body.keys || []));
      return;
    }

    // Default: scan emails → dashboard queue only (no GHL writes).
    res.status(200).json(await handleSync());
  } catch (err) {
    res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
};
