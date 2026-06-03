// Bulk import: pulls ALL GHL contacts, keeps those tagged meta / meta fda.
const { transformContact, hasQualifyingTag, normalizeTags } = require('./_lib/transform');
const { saveLead, isConfigured, getAllLeads, deleteLead } = require('./_lib/store');
const { ghlConfigured, fetchQualifyingContacts, fetchCustomFieldDefs, collectTagSamples } = require('./_lib/ghl-client');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST' && req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Use GET or POST' });
    return;
  }

  const secret = process.env.SYNC_SECRET || process.env.WEBHOOK_SECRET;
  if (secret) {
    const provided = req.headers['x-sync-secret'] || req.headers['x-webhook-secret'] || (req.query && req.query.secret);
    if (provided !== secret) {
      res.status(401).json({ ok: false, error: 'Invalid sync secret' });
      return;
    }
  }

  if (!isConfigured()) {
    res.status(500).json({ ok: false, error: 'KV storage not configured' });
    return;
  }

  if (!ghlConfigured()) {
    res.status(500).json({
      ok: false,
      error: 'GoHighLevel API not configured. Add GHL_API_KEY (or GHL_ACCESS_TOKEN) and GHL_LOCATION_ID in Vercel env vars.',
    });
    return;
  }

  const debug = req.query && (req.query.debug === '1' || req.query.debug === 'true');

  // One-off cleanup: ?purgeTests=1 removes leads with example.com / test.com emails.
  if (req.query && (req.query.purgeTests === '1' || req.query.purgeTests === 'true')) {
    try {
      const all = await getAllLeads();
      const removed = [];
      for (const l of all) {
        const email = (l.email || '').toLowerCase();
        if (email.includes('example.com') || email.includes('@test.com')) {
          await deleteLead(l.id);
          removed.push(l.id);
        }
      }
      res.status(200).json({ ok: true, purged: removed.length, removed });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err && err.message || err) });
    }
    return;
  }

  try {
    const { contacts, total } = await fetchQualifyingContacts();
    let imported = 0;
    let skipped = 0;

    for (const contact of contacts) {
      const tags = normalizeTags(contact.tags);
      if (!hasQualifyingTag(tags)) {
        skipped++;
        continue;
      }
      const lead = transformContact(contact);
      await saveLead(lead);
      imported++;
    }

    const all = await getAllLeads();
    const response = {
      ok: true,
      fetched: contacts.length,
      totalInGhl: total != null ? total : 'unknown',
      imported,
      skipped,
      stored: all.length,
    };

    // Always include the distinct tags we saw so tag-name mismatches are obvious.
    const tagCounts = collectTagSamples(contacts);
    response.tagsFound = tagCounts;

    if (debug) {
      const sample = contacts.find(c => Array.isArray(c.customFields) && c.customFields.length) || contacts[0];
      response.sampleContact = sample
        ? { tags: sample.tags, customFields: sample.customFields, keys: Object.keys(sample) }
        : null;
      try {
        const defs = await fetchCustomFieldDefs();
        response.customFieldDefs = defs.fields.map(f => ({ id: f.id, name: f.name, fieldKey: f.fieldKey, dataType: f.dataType }));
      } catch (e) {
        response.customFieldDefsError = String(e && e.message || e);
      }
    }

    res.status(200).json(response);
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err && err.message || err) });
  }
};
