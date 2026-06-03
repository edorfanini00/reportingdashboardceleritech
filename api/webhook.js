// GoHighLevel -> dashboard ingestion endpoint.
// Point a GHL Workflow "Webhook" action here (trigger: Contact Tag = meta / meta fda).
const { transformContact, normalizeTags, hasQualifyingTag } = require('./_lib/transform');
const { saveLead, isConfigured, getFieldMap } = require('./_lib/store');

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.length) {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed. Use POST.' });
    return;
  }

  // Optional shared-secret check: set WEBHOOK_SECRET in Vercel and pass ?secret= or x-webhook-secret header.
  const required = process.env.WEBHOOK_SECRET;
  if (required) {
    const provided = req.headers['x-webhook-secret'] || (req.query && req.query.secret);
    if (provided !== required) { res.status(401).json({ ok: false, error: 'Invalid secret' }); return; }
  }

  if (!isConfigured()) {
    res.status(500).json({ ok: false, error: 'Storage not configured. Add a Vercel KV store and redeploy (sets KV_REST_API_URL / KV_REST_API_TOKEN).' });
    return;
  }

  try {
    const payload = await readBody(req);
    const tags = normalizeTags(payload.tags || (payload.contact && payload.contact.tags) || payload.tag);

    if (!hasQualifyingTag(tags)) {
      res.status(200).json({ ok: true, skipped: true, reason: 'Contact must have a meta / fda tag (e.g. "meta lead", "meta lead fda", "fda")', tags });
      return;
    }

    let fieldMap = {};
    try { fieldMap = await getFieldMap(); } catch (e) { /* optional */ }
    const lead = transformContact(payload, fieldMap);
    await saveLead(lead);
    res.status(200).json({ ok: true, lead });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err && err.message || err) });
  }
};
