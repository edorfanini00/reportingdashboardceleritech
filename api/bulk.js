// Endpoint that creates and processes bulk-action jobs in small fast requests.
const { ghlConfigured } = require('./_lib/ghl-client');
const { createBulkJob, processBulkJob, resolveAll, bulkQueuedMessage } = require('./_lib/bulk');

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

    // Temporary diagnostic: report the raw KV error instead of swallowing it.
    if (body.action === 'kv_probe') {
      const out = { env: {
        KV_REST_API_URL: !!process.env.KV_REST_API_URL,
        KV_REST_API_TOKEN: !!process.env.KV_REST_API_TOKEN,
        KV_URL: !!process.env.KV_URL,
        REDIS_URL: !!process.env.REDIS_URL,
        urlHost: (() => { try { return new URL(process.env.KV_REST_API_URL).host; } catch { return null; } })(),
      } };
      try {
        const { kv } = require('@vercel/kv');
        await kv.set('probe:diag', { t: Date.now() }, { ex: 60 });
        out.set = 'ok';
        out.get = await kv.get('probe:diag');
      } catch (e) {
        out.kvError = String((e && e.message) || e);
      }
      res.status(200).json({ ok: true, ...out });
      return;
    }

    if (body.action === 'create') {
      const op = body.op;
      if (!op) {
        res.status(400).json({ ok: false, error: 'Missing op.' });
        return;
      }
      const job = await createBulkJob({
        op,
        fields: body.fields,
        tags: body.tags,
        contactIds: body.contactIds,
        tag: body.tag,
        allTags: body.allTags,
      });
      // Resolve the full target count up front (bounded) so the progress bar
      // shows a real "0 / N" total immediately instead of "0 / …".
      let resolved = job;
      if (!job.resolved) {
        resolved = (await resolveAll(job.id, 8000)) || job;
      }
      res.status(200).json({
        ok: true,
        jobId: resolved.id,
        op: resolved.op,
        total: resolved.total,
        message: bulkQueuedMessage(resolved),
        bulkJob: { id: resolved.id, total: resolved.total, op: resolved.op },
      });
      return;
    }

    if (body.action === 'process') {
      if (!body.jobId) {
        res.status(400).json({ ok: false, error: 'Missing jobId.' });
        return;
      }
      const chunk = Math.min(Math.max(1, Number(body.chunk) || 3), 10);
      const status = await processBulkJob(body.jobId, chunk);
      if (status.error) {
        res.status(404).json({ ok: false, error: status.error });
        return;
      }
      res.status(200).json({ ok: true, ...status });
      return;
    }

    res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
};
