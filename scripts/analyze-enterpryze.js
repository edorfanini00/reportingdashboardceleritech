#!/usr/bin/env node
// Read-only analysis: compare the contacts we tagged `sentbyjhon` against the
// contacts that carry the `enterpryze` / `enterpryze importers` tag or an
// Enterpryze source. Prints set sizes and overlaps. Makes NO changes.

const path = require('path');
loadEnv(path.join(__dirname, '.env'));
const ghl = require('../api/_lib/ghl-client');

const TAGS_TO_PULL = ['sentbyjhon', 'enterpryze', 'enterpryze importers'];

async function fetchAllByTag(tag, pageLimit = 100, maxPages = 100) {
  const all = [];
  let page = 1;
  for (let i = 0; i < maxPages; i++) {
    const { batch } = await ghl.searchPage({
      page,
      pageLimit,
      filters: [{ field: 'tags', operator: 'eq', value: tag }],
    });
    all.push(...batch);
    if (batch.length < pageLimit) break;
    page++;
  }
  return all;
}

function idOf(c) { return c.id || c.contactId || `${c.email || ''}|${c.phone || ''}`; }
function label(c) {
  const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || c.contactName || '(no name)';
  return `${name} <${c.email || 'no-email'}> ${c.companyName ? '@' + c.companyName : ''}`.trim();
}

async function main() {
  if (!ghl.ghlConfigured()) throw new Error('GHL not configured.');

  const sets = {};
  for (const tag of TAGS_TO_PULL) {
    const contacts = await fetchAllByTag(tag);
    sets[tag] = new Map(contacts.map(c => [idOf(c), c]));
    console.log(`Tag "${tag}": ${sets[tag].size} contact(s)`);
  }

  // Inspect the `source` field on the sentbyjhon set for visibility.
  const john = sets['sentbyjhon'];
  const sourceCounts = {};
  for (const c of john.values()) {
    const s = (c.source || '(none)').toString();
    sourceCounts[s] = (sourceCounts[s] || 0) + 1;
  }
  console.log('\nSource breakdown of `sentbyjhon` contacts:');
  for (const [s, n] of Object.entries(sourceCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n.toString().padStart(3)}  ${s}`);
  }

  // Compare sentbyjhon vs each enterpryze tag.
  for (const tag of ['enterpryze', 'enterpryze importers']) {
    const other = sets[tag];
    if (!other.size) { console.log(`\n(no contacts with tag "${tag}" — skipping comparison)`); continue; }
    const inBoth = [...john.keys()].filter(k => other.has(k));
    const onlyJohn = [...john.keys()].filter(k => !other.has(k));
    const onlyOther = [...other.keys()].filter(k => !john.has(k));

    console.log(`\n===== sentbyjhon (${john.size}) vs "${tag}" (${other.size}) =====`);
    console.log(`  in BOTH:            ${inBoth.length}`);
    console.log(`  only in sentbyjhon: ${onlyJohn.length}`);
    console.log(`  only in "${tag}":   ${onlyOther.length}`);

    const same = inBoth.length === john.size && inBoth.length === other.size;
    console.log(`  => ${same ? 'IDENTICAL sets' : 'NOT identical'}`);

    if (onlyJohn.length) {
      console.log(`\n  -- only in sentbyjhon (not tagged "${tag}") --`);
      onlyJohn.slice(0, 50).forEach(k => console.log(`     ${label(john.get(k))}`));
      if (onlyJohn.length > 50) console.log(`     ...and ${onlyJohn.length - 50} more`);
    }
    if (onlyOther.length) {
      console.log(`\n  -- only in "${tag}" (we did NOT tag sentbyjhon) --`);
      onlyOther.slice(0, 50).forEach(k => console.log(`     ${label(other.get(k))}`));
      if (onlyOther.length > 50) console.log(`     ...and ${onlyOther.length - 50} more`);
    }
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
