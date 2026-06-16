// John lead workflow:
//   GET                       — list dashboard queue (fast, from KV; no email scan)
//   GET ?meta=1               — pipelines (with stages) + users for the picker
//   POST { action:'sync' }    — scan John's emails → import new leads into queue
//   POST { action:'update', key, patch } — edit a queued lead / set pipeline/stage/rep
//   POST { action:'send', keys:[...] }   — upload selected leads to GoHighLevel
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

const DEFAULTS = { pipelineId: PIPELINE_ID, stageId: STAGE_ID, assignedTo: NATALIE_ID };

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

function listResponse(leads, extra = {}) {
  const annotated = johnQueue.annotateDuplicates(leads);
  const pending = annotated.filter(l => l.status === 'pending');
  const sent = annotated.filter(l => l.status === 'sent');
  return {
    ok: true,
    defaults: DEFAULTS,
    pending: pending.length,
    sent: sent.length,
    total: annotated.length,
    leads: annotated.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'pending' ? -1 : 1;
      if (!!b.isNew !== !!a.isNew) return a.isNew ? -1 : 1;
      if (a.isDuplicateCompany !== b.isDuplicateCompany) return a.isDuplicateCompany ? -1 : 1;
      return (a.company || a.email).localeCompare(b.company || b.email);
    }),
    ...extra,
  };
}

async function handleSync() {
  const token = await getAccessToken();
  const messages = await fetchMessagesFromSender(token, process.env.JOHN_EMAIL, { max: 2000 });
  const all = extractFromMessages(messages);
  // Require an email — phone-only matches are noise (random numbers in signatures).
  const candidates = all.filter(c => !isExcluded(c) && c.email);
  // Drop any phone-only junk that a previous version may have stored.
  await johnQueue.pruneNoEmail();

  // One-time carry-over: leads auto-synced before the review queue existed.
  let legacySentKeys = null;
  try {
    const { kv } = require('@vercel/kv');
    const old = (await kv.hgetall('johnsync:processed')) || {};
    if (Object.keys(old).length) legacySentKeys = new Map(Object.entries(old));
  } catch { /* optional */ }

  const merge = await johnQueue.mergeCandidates(candidates, { legacySentKeys });

  // Flag which pending leads already exist in the CRM (stored, so list stays fast).
  const map = await johnQueue.getMap();
  const flags = {};
  for (const l of Object.values(map)) {
    if (l.status === 'pending') {
      try { flags[l.id] = !!(await matchContact(l)); } catch { /* best-effort */ }
    }
  }
  await johnQueue.setInCrmFlags(flags);

  const leads = await johnQueue.getAll();
  return listResponse(leads, {
    fetchedEmails: messages.length,
    candidates: candidates.length,
    skippedInternal: all.length - candidates.length,
    added: merge.added,
  });
}

async function handleSend(keys) {
  if (!Array.isArray(keys) || !keys.length) throw new Error('No leads selected.');
  await ghl.createLocationTag(TAG).catch(() => {});

  const map = await johnQueue.getMap();
  const summary = { tagged: 0, created: 0, opportunities: 0, sent: 0, skipped: [], errors: [] };
  const sentKeys = [];

  for (const key of keys) {
    const c = map[key];
    if (!c || c.status === 'sent') continue;
    const hasName = !!((c.name || '').trim());
    const pipelineId = c.pipelineId || DEFAULTS.pipelineId;
    const stageId = c.stageId || DEFAULTS.stageId;
    const assignedTo = c.assignedTo || DEFAULTS.assignedTo;
    try {
      const match = await matchContact(c);
      let contactId;
      if (match) {
        contactId = match.id;
        await ghl.addTagsToContact(contactId, [TAG]);
        await ghl.updateContact(contactId, {
          source: SOURCE,
          ...(c.company ? { companyName: c.company } : {}),
          ...(c.website ? { website: c.website } : {}),
          ...(c.address1 ? { address1: c.address1 } : {}),
          ...(c.city ? { city: c.city } : {}),
          ...(c.state ? { state: c.state } : {}),
          ...(c.postalCode ? { postalCode: c.postalCode } : {}),
        });
        summary.tagged++;
      } else {
        // Don't create nameless contacts — make the user add a name first.
        if (!hasName) {
          summary.skipped.push({ key, reason: 'needs a name' });
          continue;
        }
        const [firstName, ...rest] = (c.name || '').split(' ');
        const created = await ghl.createContact({
          firstName: firstName || undefined,
          lastName: rest.join(' ') || undefined,
          email: c.email || undefined,
          phone: c.phone || undefined,
          companyName: c.company || undefined,
          website: c.website || undefined,
          address1: c.address1 || undefined,
          city: c.city || undefined,
          state: c.state || undefined,
          postalCode: c.postalCode || undefined,
          source: SOURCE,
          tags: [TAG],
          assignedTo,
        });
        contactId = created.id || (created.contact && created.contact.id);
        summary.created++;
        if (contactId) {
          await ghl.createOpportunity({
            pipelineId,
            pipelineStageId: stageId,
            name: c.company || c.name || c.email || 'New Lead',
            contactId,
            assignedTo,
            status: 'open',
          });
          summary.opportunities++;
        }
      }
      // Attach John's email detail as a note (title + notes context).
      if (contactId) {
        const noteBody = [c.title ? `Title/Role: ${c.title}` : '', c.notes || '']
          .filter(Boolean).join('\n');
        if (noteBody.trim()) await ghl.addNote(contactId, noteBody, assignedTo).catch(() => {});
      }
      summary.sent++;
      sentKeys.push(key);
    } catch (err) {
      summary.errors.push({ key, error: String((err && err.message) || err) });
    }
  }

  if (sentKeys.length) await johnQueue.markSent(sentKeys);
  const leads = await johnQueue.getAll();
  return listResponse(leads, summary);
}

async function handleMeta() {
  const [pipelines, users] = await Promise.all([
    ghl.listPipelines().catch(() => []),
    ghl.listUsers().catch(() => []),
  ]);
  return {
    ok: true,
    defaults: DEFAULTS,
    pipelines: (pipelines || []).map(p => ({
      id: p.id,
      name: p.name,
      stages: (p.stages || []).map(s => ({ id: s.id, name: s.name })),
    })),
    users: (users || []).map(u => ({
      id: u.id,
      name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.name || u.email,
      email: u.email,
    })),
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.JOHN_EMAIL) { res.status(500).json({ ok: false, error: 'JOHN_EMAIL not set.' }); return; }
  if (!process.env.KV_REST_API_URL) { res.status(500).json({ ok: false, error: 'KV not configured.' }); return; }

  try {
    if (req.method === 'GET') {
      if (String((req.query && req.query.meta) || '') === '1') {
        if (!ghl.ghlConfigured()) { res.status(500).json({ ok: false, error: 'GoHighLevel not configured.' }); return; }
        res.status(200).json(await handleMeta());
        return;
      }
      // Fast list straight from KV (no email scan) so the UI persists on refresh.
      const leads = await johnQueue.getAll();
      res.status(200).json(listResponse(leads));
      return;
    }

    if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Use GET or POST' }); return; }

    const body = await readBody(req);
    const action = body.action || 'sync';

    if (action === 'update') {
      const updated = await johnQueue.updateLead(body.key, body.patch || {});
      if (!updated) { res.status(404).json({ ok: false, error: 'Lead not found.' }); return; }
      res.status(200).json({ ok: true, lead: updated });
      return;
    }

    if (!ghl.ghlConfigured()) { res.status(500).json({ ok: false, error: 'GoHighLevel not configured.' }); return; }

    if (action === 'send') {
      res.status(200).json(await handleSend(body.keys || []));
      return;
    }

    res.status(200).json(await handleSync());
  } catch (err) {
    res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
};
