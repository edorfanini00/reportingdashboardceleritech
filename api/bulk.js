// Endpoint that processes bulk-action jobs one small chunk per request.
// The client calls this repeatedly until the job reports done, keeping every
// request well under the serverless timeout.
const { ghlConfigured } = require('./_lib/ghl-client');
const { processBulkJob } = require('./_lib/bulk');

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
    if (body.action === 'process') {
      if (!body.jobId) {
        res.status(400).json({ ok: false, error: 'Missing jobId.' });
        return;
      }
      const chunk = Math.min(Math.max(1, Number(body.chunk) || 8), 25);
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
