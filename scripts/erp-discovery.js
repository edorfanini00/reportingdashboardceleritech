#!/usr/bin/env node
// Read-only discovery for the ERP-import step: pipelines/stages, users, and the
// full email bodies for the 3 contacts we want to create.

const path = require('path');
loadEnv(path.join(__dirname, '.env'));

const { getAccessToken, fetchMessagesFromSender } = require('./lib/graph');
const ghl = require('../api/_lib/ghl-client');

const BASE = 'https://services.leadconnectorhq.com';
const TARGET_EMAILS = ['bdennis@celticseasalt.com', 'mike.goynes@catenaclearing.io', 'smontich@emaelectromechanics.com'];

function headers() {
  const { token } = ghl.getCredentials();
  return { Authorization: `Bearer ${token}`, Version: '2021-07-28', Accept: 'application/json' };
}

async function getJson(url) {
  const res = await fetch(url, { headers: headers() });
  const text = await res.text();
  if (!res.ok) throw new Error(`${url} -> ${res.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return {}; }
}

async function main() {
  const { locationId } = ghl.getCredentials();

  console.log('===== PIPELINES & STAGES =====');
  const pipes = await getJson(`${BASE}/opportunities/pipelines?locationId=${locationId}`);
  for (const p of (pipes.pipelines || pipes.data || [])) {
    console.log(`\nPipeline: "${p.name}"  id=${p.id}`);
    for (const s of (p.stages || [])) console.log(`   stage: "${s.name}"  id=${s.id}`);
  }

  console.log('\n===== USERS (looking for Natalie) =====');
  try {
    const users = await getJson(`${BASE}/users/?locationId=${locationId}`);
    for (const u of (users.users || users.data || [])) {
      const name = `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.name || '';
      console.log(`   ${name} <${u.email || ''}>  id=${u.id}`);
    }
  } catch (e) {
    console.log('   users list failed:', e.message);
  }

  console.log('\n===== FULL EMAIL BODIES FOR THE 3 CONTACTS =====');
  const token = await getAccessToken();
  const messages = await fetchMessagesFromSender(token, process.env.JOHN_EMAIL, { max: 5000 });
  for (const target of TARGET_EMAILS) {
    const msg = messages.find(m => (m.bodyText || '').toLowerCase().includes(target.toLowerCase()));
    console.log(`\n----- ${target} -----`);
    if (!msg) { console.log('   (not found in any email)'); continue; }
    console.log(`Subject: ${msg.subject}  (${msg.receivedDateTime})`);
    const body = msg.bodyText || '';
    const idx = body.toLowerCase().indexOf(target.toLowerCase());
    const start = Math.max(0, idx - 600);
    console.log(body.slice(start, idx + 600).replace(/\n{2,}/g, '\n').trim());
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
