#!/usr/bin/env node
// Import the Meta "Gas & Oil to Venezuela" lead-ad CSVs into GoHighLevel:
// match by email (enrich) or create, populate the oil & gas form fields, and
// apply the tags `oil and gas` + `oil and gas meta lead` (GHL workflows then
// move them to the right pipeline + trigger sequences).
//
// Dry run by default; pass --apply to write to GHL.

const path = require('path');
const fs = require('fs');
loadEnv(path.join(__dirname, '.env'));
const ghl = require('../api/_lib/ghl-client');

const APPLY = process.argv.includes('--apply');
const DIR = '/Users/edorfanini/Desktop/Celeritech/leads list/oil and gas';
const FILES = [
  '(Growth) Lead Ads - Celeritech - June2026 - Gas & Oil video1_Leads_2026-06-15_2026-06-15.csv',
  '(Growth) Lead Ads - Celeritech - June2026 - Gas & Oil video2_Leads_2026-06-15_2026-06-15.csv',
];
const TAGS = ['oil and gas', 'oil and gas meta lead'];
const SOURCE = 'Meta - Oil & Gas (VE)';

// fieldKey -> value column matcher (by normalized header text).
const FIELD_MAP = [
  { key: 'contact.role_in_the_company', match: h => h === 'job_title', clean: false },
  { key: 'contact.organization_type', match: h => /role.*corridor|describes.*organization/.test(h), clean: true },
  { key: 'contact.current_software_oil', match: h => /accounting_or_erp|current.*software/.test(h), clean: true },
  { key: 'contact.timeline_oil_and_gas', match: h => /timeline|deploying/.test(h), clean: true },
  { key: 'contact.number_of_entities', match: h => /entities|joint_ventures|jvs/.test(h), clean: true },
];

function parseCSV(text) {
  const rows = []; let row = []; let cur = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (ch === '\r') { /* skip */ }
    else cur += ch;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

// Restore casing Meta's export lowercased.
const CASE_FIX = {
  sap: 'SAP', erp: 'ERP', jv: 'JV', '(jv)': '(JV)', netsuite: 'NetSuite',
  quickbooks: 'QuickBooks', odoo: 'Odoo', microsoft: 'Microsoft', dynamics: 'Dynamics',
  us: 'US', ve: 'VE',
};
function fixCasing(s) {
  return s.split(' ').map(w => CASE_FIX[w.toLowerCase()] || w).join(' ');
}

// Strip Meta's option bullet (shows as ¥/•) and underscores → readable text.
function cleanAnswer(v) {
  if (!v) return '';
  let s = String(v).trim().replace(/^[^\p{L}\p{N}]+/u, '');
  s = s.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return fixCasing(s);
}

function colIndex(headers, pred) { return headers.findIndex(h => pred(h)); }

function readLeads() {
  const out = [];
  for (const file of FILES) {
    const full = path.join(DIR, file);
    if (!fs.existsSync(full)) { console.log(`(missing) ${file}`); continue; }
    const rows = parseCSV(fs.readFileSync(full, 'utf8')).filter(r => r.length > 1 && r.join('').trim());
    if (!rows.length) continue;
    const headers = rows[0].map(h => h.trim().toLowerCase());
    const idx = {
      email: colIndex(headers, h => h.includes('email')),
      name: colIndex(headers, h => h === 'full_name'),
      company: colIndex(headers, h => h === 'company_name'),
      phone: colIndex(headers, h => h.includes('phone')),
      adName: colIndex(headers, h => h === 'ad_name'),
      platform: colIndex(headers, h => h === 'platform'),
    };
    for (const r of rows.slice(1)) {
      const email = (r[idx.email] || '').trim().toLowerCase();
      if (!email) continue;
      const [firstName, ...rest] = (r[idx.name] || '').trim().split(' ');
      const custom = [];
      for (const fm of FIELD_MAP) {
        const ci = colIndex(headers, fm.match);
        if (ci === -1) continue;
        const raw = r[ci] || '';
        const val = fm.clean ? cleanAnswer(raw) : raw.trim();
        if (val) custom.push({ key: fm.key, value: val });
      }
      out.push({
        email,
        firstName: firstName || '',
        lastName: rest.join(' ') || '',
        company: (r[idx.company] || '').trim(),
        phone: (r[idx.phone] || '').trim(),
        adName: (r[idx.adName] || '').trim(),
        platform: (r[idx.platform] || '').trim(),
        custom,
      });
    }
  }
  // Dedupe by email (last wins).
  const byEmail = new Map();
  for (const l of out) byEmail.set(l.email, l);
  return [...byEmail.values()];
}

function noteFor(l) {
  const lines = [`Meta lead-ad: ${l.adName || ''} (${(l.platform || '').toUpperCase()})`];
  for (const c of l.custom) lines.push(`${c.key.replace('contact.', '')}: ${c.value}`);
  return lines.join('\n');
}

async function main() {
  if (!ghl.ghlConfigured()) throw new Error('GHL not configured.');
  const leads = readLeads();
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'} | leads: ${leads.length} | tags: ${TAGS.join(', ')}\n`);

  // Map fieldKey -> id for customFields payload.
  const fieldMap = await ghl.fetchCustomFieldMap();
  const keyToId = {};
  for (const [id, meta] of Object.entries(fieldMap)) if (meta.fieldKey) keyToId[meta.fieldKey] = id;

  for (const l of leads) {
    const customFields = l.custom
      .map(c => ({ id: keyToId[c.key], value: c.value }))
      .filter(c => c.id);
    const missing = l.custom.filter(c => !keyToId[c.key]).map(c => c.key);

    console.log(`• ${l.firstName} ${l.lastName} <${l.email}> @${l.company} (${l.phone})`);
    for (const c of l.custom) console.log(`    ${c.key.replace('contact.', '')} = ${c.value}`);
    if (missing.length) console.log(`    !! no GHL field for: ${missing.join(', ')}`);

    if (!APPLY) continue;

    try {
      let existing = await ghl.searchContactsByEmail(l.email);
      if (!existing.length && l.phone) existing = await ghl.searchContactsByPhone(l.phone);
      let id;
      if (existing.length) {
        id = existing[0].id;
        await ghl.updateContact(id, {
          email: l.email || undefined,
          firstName: l.firstName || undefined,
          lastName: l.lastName || undefined,
          phone: l.phone || undefined,
          companyName: l.company || undefined,
          source: SOURCE,
          customFields,
        });
        await ghl.addTagsToContact(id, TAGS);
        console.log('    -> enriched + tagged existing contact');
      } else {
        const created = await ghl.createContact({
          firstName: l.firstName || undefined,
          lastName: l.lastName || undefined,
          email: l.email,
          phone: l.phone || undefined,
          companyName: l.company || undefined,
          source: SOURCE,
          tags: TAGS,
          customFields,
        });
        id = created.id || (created.contact && created.contact.id);
        console.log('    -> created + tagged new contact');
      }
      if (id) await ghl.addNote(id, noteFor(l)).catch(() => {});
    } catch (err) {
      console.log(`    FAILED: ${err.message}`);
    }
  }

  if (!APPLY) console.log('\nDry run. Re-run with --apply to write to GHL.');
}

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
