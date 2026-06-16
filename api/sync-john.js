// "Sync John" — reads John's emails, extracts the leads he shared, and pushes
// them into the Enterpryze pipeline / ERP Qualified stage, assigned to Natalie,
// with source "Enterpryze" and tag "sentbyjhon".
//
// - Existing CRM contacts: ensure tag + source (no new opportunity).
// - Brand-new contacts: create contact + opportunity.
// - Idempotent: each lead (by email/phone) is tracked in KV so repeat clicks
//   only process new leads. Time-budgeted so large first runs finish over a few
//   clicks instead of timing out.
const { kv } = require('@vercel/kv');
const ghl = require('./_lib/ghl-client');
const { getAccessToken, fetchMessagesFromSender } = require('./_lib/ms-graph');
const { extractFromMessages, emailVariants } = require('./_lib/extract');

const PIPELINE_ID = process.env.ENTERPRYZE_PIPELINE_ID || 'FGMXcH1ZySUFZSmV2R00';
const STAGE_ID = process.env.ERP_QUALIFIED_STAGE_ID || '60a21606-5d7e-402f-85ac-74cde9e57f2f';
const NATALIE_ID = process.env.NATALIE_USER_ID || '4J8l9pZV4WcpYyqtpkj7';
const TAG = process.env.SENT_TAG || 'sentbyjhon';
const SOURCE = process.env.CONTACT_SOURCE || 'Enterpryze';
const EXCLUDE_DOMAINS = (process.env.EXCLUDE_DOMAINS || 'celeritech.biz,enterpryze.com')
  .split(',').map(d => d.trim().toLowerCase()).filter(Boolean);

const PROCESSED_KEY = 'johnsync:processed';
const TIME_BUDGET_MS = 45000;

function isExcluded(c) {
  const domain = (c.email || '').split('@')[1] || '';
  return EXCLUDE_DOMAINS.includes(domain.toLowerCase());
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

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Use POST' });
    return;
  }
  if (!ghl.ghlConfigured()) { res.status(500).json({ ok: false, error: 'GoHighLevel not configured.' }); return; }
  if (!process.env.JOHN_EMAIL) { res.status(500).json({ ok: false, error: 'JOHN_EMAIL not set.' }); return; }
  if (!process.env.KV_REST_API_URL) { res.status(500).json({ ok: false, error: 'KV not configured (needed to track processed leads).' }); return; }

  const preview = String((req.query && req.query.preview) || '') === '1';
  const started = Date.now();
  const summary = { preview, fetchedEmails: 0, candidates: 0, alreadyDone: 0, tagged: 0, created: 0, opportunities: 0, skippedInternal: 0, errors: [], partial: false, remaining: 0 };

  try {
    const token = await getAccessToken();
    const messages = await fetchMessagesFromSender(token, process.env.JOHN_EMAIL, { max: 2000 });
    summary.fetchedEmails = messages.length;

    const all = extractFromMessages(messages);
    const candidates = all.filter(c => !isExcluded(c));
    summary.skippedInternal = all.length - candidates.length;
    summary.candidates = candidates.length;

    const processed = (await kv.hgetall(PROCESSED_KEY)) || {};

    const pending = candidates.filter(c => {
      const key = c.email || c.phone;
      return key && !processed[key];
    });
    summary.alreadyDone = candidates.length - pending.length;

    // Preview: authenticate + read mailbox, report counts, no GHL writes.
    if (preview) {
      summary.newLeads = pending.length;
      summary.sampleNew = pending.slice(0, 10).map(c => ({ name: c.name || '', email: c.email || '', phone: c.phone || '', company: c.company || '' }));
      res.status(200).json({ ok: true, ...summary });
      return;
    }

    await ghl.createLocationTag(TAG).catch(() => {});

    let i = 0;
    for (; i < pending.length; i++) {
      if (Date.now() - started > TIME_BUDGET_MS) { summary.partial = true; break; }
      const c = pending[i];
      const key = c.email || c.phone;
      try {
        const match = await matchContact(c);
        if (match) {
          // Existing contact: ensure tag + source, no new opportunity.
          await ghl.addTagsToContact(match.id, [TAG]);
          await ghl.updateContact(match.id, { source: SOURCE });
          summary.tagged++;
        } else {
          // New contact: create + opportunity in Enterpryze / ERP Qualified.
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
        await kv.hset(PROCESSED_KEY, { [key]: new Date().toISOString() });
      } catch (err) {
        summary.errors.push({ key, error: String((err && err.message) || err) });
      }
    }

    summary.remaining = summary.partial ? (pending.length - i) : 0;
    res.status(200).json({ ok: true, ...summary });
  } catch (err) {
    res.status(500).json({ ok: false, error: String((err && err.message) || err), ...summary });
  }
};
