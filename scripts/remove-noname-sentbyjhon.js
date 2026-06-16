#!/usr/bin/env node
// Remove GoHighLevel contacts tagged `sentbyjhon` that have NO name (first/last/
// contactName all empty). These came from the earlier auto-sync's weak/phone-only
// extractions. Dry run by default; pass --apply to actually delete.

const path = require('path');
loadEnv(path.join(__dirname, '.env'));
const ghl = require('../api/_lib/ghl-client');

const APPLY = process.argv.includes('--apply');
const TAG = process.env.SENT_TAG || 'sentbyjhon';

// A real person name = firstName or lastName. `contactName` is ignored because
// GHL auto-derives it from the email domain (e.g. "ymail"), which is not a name.
function hasName(c) {
  return Boolean((c.firstName || '').trim() || (c.lastName || '').trim());
}
function label(c) {
  const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || c.contactName || '(no name)';
  return `${name} <${c.email || 'no-email'}> ${c.phone || ''} ${c.companyName ? '@' + c.companyName : ''}`.trim();
}

async function main() {
  if (!ghl.ghlConfigured()) throw new Error('GHL not configured.');
  console.log(`Mode: ${APPLY ? 'APPLY (deleting)' : 'DRY RUN'} | tag: ${TAG}\n`);

  const tagged = await ghl.searchByTagEquals(TAG, 100, 100);
  const noName = tagged.filter(c => !hasName(c));

  console.log(`Tagged "${TAG}": ${tagged.length} | without a name: ${noName.length}\n`);
  noName.forEach((c, i) => console.log(`${i + 1}. ${label(c)}  [id ${c.id}]`));

  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to delete these.');
    return;
  }

  console.log('\nDeleting...\n');
  let ok = 0, fail = 0;
  for (const c of noName) {
    try {
      await ghl.deleteContact(c.id);
      ok++;
      console.log(`  deleted: ${label(c)}`);
    } catch (err) {
      fail++;
      console.log(`  FAILED:  ${label(c)} -> ${err.message}`);
    }
  }
  console.log(`\nDone. Deleted ${ok}, failed ${fail}.`);
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
