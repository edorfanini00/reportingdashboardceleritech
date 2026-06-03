// Returns all ingested GHL leads for the dashboard to render.
const { getAllLeads, isConfigured } = require('./_lib/store');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!isConfigured()) {
    res.status(200).json({ ok: false, configured: false, leads: [], error: 'Vercel KV not configured yet.' });
    return;
  }
  try {
    const leads = await getAllLeads();
    leads.sort((a, b) => new Date(b.dateISO) - new Date(a.dateISO));
    res.status(200).json({ ok: true, configured: true, count: leads.length, leads });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err && err.message || err), leads: [] });
  }
};
