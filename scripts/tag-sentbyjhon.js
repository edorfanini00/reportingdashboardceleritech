#!/usr/bin/env node
// Tag every CRM contact that John shared in his emails with `sentbyjhon`.
//
// Flow:
//   1. Sign in to YOUR Microsoft 365 mailbox (device-code flow).
//   2. Pull all emails received FROM John.
//   3. Extract the contacts he wrote in the email bodies (email / phone / name / company).
//   4. Match each against the GoHighLevel CRM.
//   5. Add the `sentbyjhon` tag to every match.
//
// SAFE BY DEFAULT: runs as a dry-run (reports only). Pass --apply to write tags.
//
// Required env vars (put them in scripts/.env, see scripts/.env.example):
//   MS_CLIENT_ID, MS_TENANT_ID        (Azure App Registration)
//   JOHN_EMAIL                        (John's sender address)
//   GHL_API_KEY (or GHL_ACCESS_TOKEN), GHL_LOCATION_ID
// Optional:
//   TAG_NAME (default "sentbyjhon"), GHL_TAGS unaffected, MAX_EMAILS

const path = require('path');
loadEnv(path.join(__dirname, '.env'));

const { getAccessToken, fetchMessagesFromSender } = require('./lib/graph');
const { extractFromMessages } = require('./lib/extract');
const ghl = require('../api/_lib/ghl-client');

const APPLY = process.argv.includes('--apply');
const INCLUDE_FUZZY = process.argv.includes('--include-fuzzy');
const FUZZY_THRESHOLD = 0.9; // only auto-include near-certain typo fixes
const TAG_NAME = process.env.TAG_NAME || 'sentbyjhon';
const CONTACT_SOURCE = process.env.CONTACT_SOURCE || 'Enterpryze';
// Internal/own domains to ignore (CC'd teammates, signatures, John himself).
const EXCLUDE_DOMAINS = (process.env.EXCLUDE_DOMAINS || 'celeritech.biz,enterpryze.com')
  .split(',').map(d => d.trim().toLowerCase()).filter(Boolean);

function isExcluded(candidate) {
  const domain = (candidate.email || '').split('@')[1] || '';
  return EXCLUDE_DOMAINS.includes(domain.toLowerCase());
}

async function main() {
  const johnEmail = process.env.JOHN_EMAIL;
  if (!johnEmail) throw new Error('Set JOHN_EMAIL to John\'s sender address.');
  if (!ghl.ghlConfigured()) {
    throw new Error('Set GHL_API_KEY (or GHL_ACCESS_TOKEN) and GHL_LOCATION_ID.');
  }

  console.log(`Mode:   ${APPLY ? 'APPLY (will write tags + source)' : 'DRY RUN (no changes)'}`);
  console.log(`Tag:    ${TAG_NAME}`);
  console.log(`Source: ${CONTACT_SOURCE}`);
  console.log(`From:   ${johnEmail}\n`);

  // 1 + 2: auth + fetch John's emails.
  const token = await getAccessToken();
  const max = Number(process.env.MAX_EMAILS) || 5000;
  const messages = await fetchMessagesFromSender(token, johnEmail, { max });
  console.log(`Fetched ${messages.length} email(s) from ${johnEmail}.`);

  // 3: extract contacts from the bodies, dropping internal/own domains.
  const rawCandidates = extractFromMessages(messages);
  const candidates = rawCandidates.filter(c => !isExcluded(c));
  const excludedCount = rawCandidates.length - candidates.length;
  console.log(`Extracted ${rawCandidates.length} distinct contact(s) from the bodies.`);
  console.log(`Excluded ${excludedCount} internal contact(s) (${EXCLUDE_DOMAINS.join(', ')}).\n`);

  // 4: match each candidate against the CRM.
  const matched = [];   // high confidence (email or phone hit)
  const review = [];     // name/company only -> needs manual review, never auto-tagged
  const notFound = [];

  for (const c of candidates) {
    const hit = await matchInCrm(c);
    if (hit.contact && hit.via !== 'name') {
      matched.push({ candidate: c, contact: hit.contact, via: hit.via });
    } else if (hit.contact && hit.via === 'name') {
      review.push({ candidate: c, contact: hit.contact, via: hit.via });
    } else {
      notFound.push(c);
    }
  }

  // 4b: fuzzy "deep match" pass over the ones strict matching missed.
  const suggestions = [];
  if (notFound.length) {
    console.log(`Running fuzzy deep-match on ${notFound.length} unmatched contact(s)...\n`);
    for (const c of notFound) {
      const hits = await deepMatch(c);
      if (hits.length) suggestions.push({ candidate: c, hits });
    }
  }

  // Promote near-certain fuzzy hits (e.g. email typo fixes) into the tag set.
  if (INCLUDE_FUZZY) {
    const known = new Set(matched.map(m => m.contact.id));
    for (const s of suggestions) {
      const best = s.hits[0];
      if (best && best.score >= FUZZY_THRESHOLD && !known.has(best.contact.id)) {
        matched.push({ candidate: s.candidate, contact: best.contact, via: 'fuzzy' });
        known.add(best.contact.id);
      }
    }
    console.log(`Including ${matched.filter(m => m.via === 'fuzzy').length} high-confidence fuzzy match(es).\n`);
  }

  printReport(matched, review, notFound, suggestions);

  // 5: apply tags to high-confidence matches only.
  if (!APPLY) {
    console.log('\nDry run complete. Re-run with --apply to write the tag.');
    return;
  }

  await ghl.createLocationTag(TAG_NAME).catch(() => {});
  let tagged = 0;
  let sourced = 0;
  const uniqueIds = [...new Map(matched.map(m => [m.contact.id, m])).values()];
  for (const m of uniqueIds) {
    const label = m.contact.email || m.contact.phone || '';
    try {
      await ghl.addTagsToContact(m.contact.id, [TAG_NAME]);
      tagged++;
      try {
        await ghl.updateContact(m.contact.id, { source: CONTACT_SOURCE });
        sourced++;
        console.log(`  tagged + sourced ${m.contact.id}  ${label}`);
      } catch (err) {
        console.error(`  tagged but SOURCE FAILED ${m.contact.id}: ${err.message}`);
      }
    } catch (err) {
      console.error(`  FAILED ${m.contact.id}: ${err.message}`);
    }
  }
  console.log(`\nDone. Applied "${TAG_NAME}" to ${tagged} contact(s); set source="${CONTACT_SOURCE}" on ${sourced}.`);
  if (review.length) {
    console.log(`${review.length} name-only match(es) were NOT tagged (review the list above).`);
  }
}

// Generate typo-corrected variants of an email (bad TLDs, stray trailing chars).
function emailVariants(email) {
  if (!email || !email.includes('@')) return [];
  const [local, domain] = email.split('@');
  const out = new Set();
  // ".comi" / ".comm" / ".como" / ".con" / ".cim" / ".ocm" / ".vom" -> ".com"
  if (/\.com[a-z]$/.test(domain)) out.add(`${local}@${domain.replace(/\.com[a-z]$/, '.com')}`);
  if (/\.(con|cim|ocm|vom|xom|cpm|comm)$/.test(domain)) {
    out.add(`${local}@${domain.replace(/\.(con|cim|ocm|vom|xom|cpm|comm)$/, '.com')}`);
  }
  // stray trailing non-domain char overall (e.g. "...com." or "...com,")
  out.add(`${local}@${domain.replace(/[^a-z0-9.\-].*$/i, '')}`);
  out.delete(email);
  return [...out].filter(Boolean);
}

function emailDomain(email) {
  return (email || '').split('@')[1] || '';
}

// Cheap similarity (0..1) on lowercased strings via Levenshtein ratio.
function similarity(a, b) {
  a = String(a || '').toLowerCase(); b = String(b || '').toLowerCase();
  if (!a || !b) return 0;
  if (a === b) return 1;
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return 1 - dp[m][n] / Math.max(m, n);
}

// Fuzzy lookup for candidates that strict matching missed. Returns
// [{ contact, reason, score }] sorted best-first (max ~3).
async function deepMatch(c) {
  const suggestions = new Map(); // contactId -> { contact, reason, score }
  const add = (contact, reason, score) => {
    if (!contact || !contact.id) return;
    const prev = suggestions.get(contact.id);
    if (!prev || score > prev.score) suggestions.set(contact.id, { contact, reason, score });
  };

  // 1) Typo-corrected email (exact search on each variant).
  for (const variant of emailVariants(c.email)) {
    try {
      const hits = await ghl.searchContactsByEmail(variant);
      for (const h of hits) add(h, `email typo fix -> ${variant}`, 0.95);
    } catch { /* ignore */ }
  }

  // 2) Same email domain: query the domain, keep contacts sharing it.
  const dom = emailDomain(c.email);
  if (dom) {
    try {
      const hits = await ghl.searchContacts({ query: dom.split('.')[0] });
      for (const h of hits) {
        if (emailDomain(h.email).toLowerCase() === dom.toLowerCase()) {
          const localSim = similarity((c.email.split('@')[0]) || '', (h.email || '').split('@')[0] || '');
          add(h, `same domain @${dom}`, 0.6 + 0.3 * localSim);
        }
      }
    } catch { /* ignore */ }
  }

  // 3) Name search (free text), ranked by name similarity.
  if (c.name) {
    try {
      const hits = await ghl.searchContacts({ query: c.name });
      for (const h of hits) {
        const full = [h.firstName, h.lastName].filter(Boolean).join(' ') || h.contactName || '';
        const s = similarity(c.name, full);
        if (s >= 0.6) add(h, `name ~ "${full}" (${s.toFixed(2)})`, s);
      }
    } catch { /* ignore */ }
  }

  return [...suggestions.values()].sort((x, y) => y.score - x.score).slice(0, 3);
}

// Try email -> phone -> name(+company). Returns { contact, via }.
async function matchInCrm(c) {
  if (c.email) {
    const byEmail = await ghl.searchContactsByEmail(c.email);
    if (byEmail.length) return { contact: byEmail[0], via: 'email' };
  }
  if (c.phone) {
    const byPhone = await ghl.searchContactsByPhone(c.phone);
    if (byPhone.length) return { contact: byPhone[0], via: 'phone' };
  }
  if (c.name) {
    const byName = await ghl.searchContactsByName(c.name, c.company);
    if (byName.length) return { contact: byName[0], via: 'name' };
  }
  return { contact: null, via: null };
}

function fmtContact(ct) {
  const name = [ct.firstName, ct.lastName].filter(Boolean).join(' ') || ct.contactName || '(no name)';
  return `${name} <${ct.email || 'no-email'}> ${ct.phone || ''} ${ct.companyName ? '@' + ct.companyName : ''}`.trim();
}

function printReport(matched, review, notFound, suggestions = []) {
  console.log('===== HIGH-CONFIDENCE MATCHES (will be tagged + source set) =====');
  if (!matched.length) console.log('  none');
  for (const m of matched) {
    console.log(`  [${m.via}] ${fmtContact(m.contact)}`);
  }

  console.log('\n===== NAME-ONLY MATCHES (review, NOT auto-tagged) =====');
  if (!review.length) console.log('  none');
  for (const r of review) {
    console.log(`  ${r.candidate.name || ''} (${r.candidate.company || '?'}) -> ${fmtContact(r.contact)}`);
  }

  console.log('\n===== NOT FOUND IN CRM =====');
  if (!notFound.length) console.log('  none');
  for (const c of notFound) {
    console.log(`  ${c.email || ''} ${c.phone || ''} ${c.name || ''} ${c.company || ''}`.trim());
  }

  if (suggestions.length) {
    console.log('\n===== POSSIBLE MATCHES (mispell / alt-email — review) =====');
    for (const s of suggestions) {
      const from = s.candidate.email || s.candidate.phone || s.candidate.name || '?';
      console.log(`  "${from}" (${s.candidate.company || ''})`);
      for (const h of s.hits) {
        console.log(`      -> ${fmtContact(h.contact)}   [${h.reason}]`);
      }
    }
  }

  console.log(`\nSummary: ${matched.length} to tag, ${review.length} to review, ${notFound.length} not found, ${suggestions.length} possible fuzzy match(es).`);
}

// Tiny .env loader (no dependency). Lines like KEY=value; ignores # comments.
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
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

main().catch(err => {
  console.error('\nError:', err.message);
  process.exit(1);
});
