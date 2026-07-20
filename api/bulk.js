// Endpoint for stateless bulk-action jobs. The dashboard holds the job state
// and drives it in small fast requests: `create` validates and echoes a job
// spec, `resolve` finds target ids page by page, `process` updates a few
// contacts per call (slowly, verified per contact). No database required.
const { ghlConfigured } = require('./_lib/ghl-client');
const { VALID_OPS, MAX_CHUNK, resolveTagPage, processChunk, bulkQueuedMessage } = require('./_lib/bulk');

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
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Use POST' });
    return;
  }
  if (!ghlConfigured()) {
    res.status(500).json({ ok: false, error: 'GoHighLevel not configured.' });
    return;
  }

  try {
    const body = await readBody(req);

    // Validate and echo a client-held job spec (nothing is stored server-side).
    if (body.action === 'create') {
      const op = body.op;
      if (!VALID_OPS.includes(op)) {
        res.status(400).json({ ok: false, error: `Unsupported bulk op: ${op || '(missing)'}` });
        return;
      }
      const contactIds = Array.isArray(body.contactIds) && body.contactIds.length
        ? [...new Set(body.contactIds.filter(Boolean))]
        : null;
      if (!contactIds && !body.tag) {
        res.status(400).json({ ok: false, error: 'Provide contactIds or a tag to match.' });
        return;
      }
      const spec = {
        op,
        fields: body.fields || null,
        tags: body.tags || null,
        tag: body.tag || null,
        allTags: body.allTags || null,
        contactIds,
        total: contactIds ? contactIds.length : null,
      };
      res.status(200).json({ ok: true, message: bulkQueuedMessage(spec), bulkJob: spec, total: spec.total });
      return;
    }

    // One page of tag-based target resolution.
    if (body.action === 'resolve') {
      if (!body.tag) {
        res.status(400).json({ ok: false, error: 'Missing tag.' });
        return;
      }
      const page = Math.max(1, Number(body.page) || 1);
      const out = await resolveTagPage(body.tag, page, body.allTags);
      res.status(200).json({ ok: true, ...out });
      return;
    }

    // Process a small chunk of contacts, one by one, verified per contact.
    if (body.action === 'process') {
      if (!VALID_OPS.includes(body.op)) {
        res.status(400).json({ ok: false, error: 'Missing or invalid op.' });
        return;
      }
      const ids = (Array.isArray(body.ids) ? body.ids : []).filter(Boolean).slice(0, MAX_CHUNK);
      if (!ids.length) {
        res.status(400).json({ ok: false, error: 'No ids provided.' });
        return;
      }
      const results = await processChunk(body.op, ids, { fields: body.fields, tags: body.tags });
      res.status(200).json({ ok: true, results });
      return;
    }

    res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
};
