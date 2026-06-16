#!/usr/bin/env node
// Read-only: list the contacts John shared by email that are NOT in the CRM,
// with full extracted details and the email context where each appeared.

const path = require('path');
loadEnv(path.join(__dirname, '.env'));

const { getAccessToken, fetchMessagesFromSender } = require('./lib/graph');
const { extractFromMessages, EMAIL_RE, PHONE_RE, normalizePhone } = require('./lib/extract');
const ghl = require('../api/_lib/ghl-client');

const EXCLUDE_DOMAINS = (process.env.EXCLUDE_DOMAINS || 'celeritech.biz,enterpryze.com')
  .split(',').map(d => d.trim().toLowerCase()).filter(Boolean);

function isExcluded(c) {
  const domain = (c.email || '').split('@')[1] || '';
  return EXCLUDE_DOMAINS.includes(domain.toLowerCase());
}

function emailVariants(email) {
  if (!email || !email.includes('@')) return [];
  const [local, domain] = email.split('@');
  const out = new Set();
  if (/\.com[a-z]$/.test(domain)) out.add(`${local}@${domain.replace(/\.com[a-z]$/, '.com')}`);
  if (/\.(con|cim|ocm|vom|xom|cpm|comm)$/.test(domain)) out.add(`${local}@${domain.replace(/\.(con|cim|ocm|vom|xom|cpm|comm)$/, '.com')}`);
  out.delete(email);
  return [...out];
}

// "In CRM" = exact email, exact phone, typo-fixed email, or a name hit.
async function inCrm(c) {
  if (c.email) {
    if ((await ghl.searchContactsByEmail(c.email)).length) return true;
    for (const v of emailVariants(c.email)) if ((await ghl.searchContactsByEmail(v)).length) return true;
  }
  if (c.phone && (await ghl.searchContactsByPhone(c.phone)).length) return true;
  if (c.name && (await ghl.searchContactsByName(c.name, c.company)).length) return true;
  return false;
}

// Same-company contacts (different person) — useful context for "not found".
async function sameCompanyContacts(c) {
  const dom = (c.email || '').split('@')[1];
  if (!dom) return [];
  try {
    const hits = await ghl.searchContacts({ query: dom.split('.')[0] });
    return hits.filter(h => (h.email || '').split('@')[1] === dom);
  } catch { return []; }
}

// Find a short context snippet for an identifier within the email bodies.
function findContext(messages, needle) {
  for (const m of messages) {
    const idx = (m.bodyText || '').toLowerCase().indexOf(needle.toLowerCase());
    if (idx !== -1) {
      const start = Math.max(0, idx - 120);
      const snippet = m.bodyText.slice(start, idx + needle.length + 120).replace(/\s+/g, ' ').trim();
      return { subject: m.subject, date: m.receivedDateTime, snippet };
    }
  }
  return null;
}

async function main() {
  if (!ghl.ghlConfigured()) throw new Error('GHL not configured.');
  const johnEmail = process.env.JOHN_EMAIL;

  const token = await getAccessToken();
  const messages = await fetchMessagesFromSender(token, johnEmail, { max: 5000 });
  const candidates = extractFromMessages(messages).filter(c => !isExcluded(c));
  console.log(`Scanned ${messages.length} emails, ${candidates.length} distinct contacts shared by John.\n`);

  const missing = [];
  for (const c of candidates) {
    if (!(await inCrm(c))) missing.push(c);
  }

  console.log(`==== ${missing.length} CONTACT(S) JOHN SHARED THAT ARE NOT IN THE CRM ====\n`);
  let i = 1;
  for (const c of missing) {
    const ctx = findContext(messages, c.email || c.phone || c.name || '');
    const coworkers = await sameCompanyContacts(c);
    console.log(`${i++}. ${c.name || '(name not given)'}${c.company ? ' — ' + c.company : ''}`);
    console.log(`   email:   ${c.email || '(none)'}`);
    console.log(`   phone:   ${c.phone || '(none)'}`);
    if (ctx) {
      console.log(`   email:   "${ctx.subject}" (${ctx.date ? ctx.date.slice(0, 10) : ''})`);
      console.log(`   context: ...${ctx.snippet}...`);
    }
    if (coworkers.length) {
      console.log(`   note:    same company is in CRM as a different person: ${coworkers.map(h => h.email).join(', ')}`);
    }
    console.log('');
  }
}

function loadEnv(file) {
  const fs = require('fs');
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
