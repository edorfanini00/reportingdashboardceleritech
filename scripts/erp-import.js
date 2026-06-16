#!/usr/bin/env node
// Create the 3 contacts John shared (that weren't in the CRM) into the
// "Enterpryze" pipeline @ "ERP Qualified" stage, assigned to Natalie Arana,
// with tag `sentbyjhon`, source `Enterpryze`, and a note holding John's details.
//
// Dry run by default; pass --apply to actually create.

const path = require('path');
loadEnv(path.join(__dirname, '.env'));
const ghl = require('../api/_lib/ghl-client');

const APPLY = process.argv.includes('--apply');

const PIPELINE_ID = 'FGMXcH1ZySUFZSmV2R00';            // "Enterpryze"
const STAGE_ID = '60a21606-5d7e-402f-85ac-74cde9e57f2f'; // "ERP Qualified"
const NATALIE_ID = '4J8l9pZV4WcpYyqtpkj7';             // Natalie Arana
const TAG = 'sentbyjhon';
const SOURCE = 'Enterpryze';

const CONTACTS = [
  {
    firstName: 'Ben',
    lastName: 'Dennis',
    email: 'bdennis@celticseasalt.com',
    phone: '+18282109121',
    companyName: 'Celtic Sea Salt',
    website: 'https://www.celticseasalt.com',
    note: [
      'Shared by John Del Rio (jdrio@enterpryze.com).',
      "Thread: 'Should I pause outreach?' (Dec 18, 2025).",
      'Ben Dennis — Chief Financial Officer, Celtic Sea Salt. Phone (828) 210-9121. www.celticseasalt.com',
      'Ben (Dec 18, 2025): "We are not in need of a new ERP at this time, feel free to reach out in Q4 of 2026."',
      'John: lead already assigned to Celeritech; not a cold lead — wants to work it to close this year.',
    ].join('\n'),
  },
  {
    firstName: 'Mike',
    lastName: 'Goynes',
    email: 'mike.goynes@catenaclearing.io',
    phone: '+17032160152',
    companyName: 'Catena Clearing',
    address1: '12 W 72nd St',
    city: 'New York',
    state: 'NY',
    postalCode: '10023',
    note: [
      'Shared by John Del Rio. Email: "Catena Clearing" (Mar 11, 2026), sent to Natalie.',
      'Mike Goynes — Co-Founder/CTO, Catena Clearing. Phone +1 703-216-0152. 12 W 72nd St, New York, NY 10023.',
      'John: "Normally this may not be a good fit, but they need container management, we may be able to do something here with the Celeritech add-on."',
      'Customer challenge: primary interest is a transportation management system. Their client Overhaul, Inc. tracks/traces containers (insurance-like); customers use SAP TMS and must manually enter data.',
    ].join('\n'),
  },
  {
    firstName: 'Sofia',
    lastName: 'Montich',
    email: 'smontich@emaelectromechanics.com',
    companyName: 'EMA Electromechanics',
    note: [
      'Shared by John / Natalie. Email: "Listado de prospectos | Potenciales para Enterpryze | Celeritech" (May 26, 2026).',
      'Sofia Montich — EMA Electromechanics (smontich@emaelectromechanics.com).',
      'Context: prospect contacted by phone, SMS and email without success to date. Reviewed profile — qualifies for Enterpryze; worth continuing follow-up through other channels.',
      'Note: full lead detail was included as an attachment in the original email.',
    ].join('\n'),
  },
];

async function main() {
  if (!ghl.ghlConfigured()) throw new Error('GHL not configured.');
  console.log(`Mode: ${APPLY ? 'APPLY (creating in GHL)' : 'DRY RUN'}`);
  console.log(`Pipeline: Enterpryze / Stage: ERP Qualified / Assigned: Natalie Arana`);
  console.log(`Tag: ${TAG} / Source: ${SOURCE}\n`);

  if (!APPLY) {
    for (const c of CONTACTS) {
      console.log(`Would create: ${c.firstName} ${c.lastName} <${c.email}> @${c.companyName}`);
      console.log(`   phone: ${c.phone || '(none)'}${c.address1 ? `  addr: ${c.address1}, ${c.city}, ${c.state} ${c.postalCode}` : ''}`);
      console.log(`   note:  ${c.note.split('\n')[0]} ...`);
      console.log('');
    }
    console.log('Dry run only. Re-run with --apply to create.');
    return;
  }

  await ghl.createLocationTag(TAG).catch(() => {});

  for (const c of CONTACTS) {
    const { note, ...fields } = c;
    try {
      const created = await ghl.createContact({
        ...fields,
        tags: [TAG],
        source: SOURCE,
        assignedTo: NATALIE_ID,
      });
      const id = created.id || (created.contact && created.contact.id);
      console.log(`Created contact ${id}  ${c.firstName} ${c.lastName}`);

      if (note) {
        await ghl.addNote(id, note, NATALIE_ID).then(() => console.log('   + note added'))
          .catch(e => console.error('   note FAILED:', e.message));
      }

      const opp = await ghl.createOpportunity({
        pipelineId: PIPELINE_ID,
        pipelineStageId: STAGE_ID,
        name: `${c.companyName} — ${c.firstName} ${c.lastName}`,
        contactId: id,
        assignedTo: NATALIE_ID,
        status: 'open',
      });
      const oppId = opp.id || (opp.opportunity && opp.opportunity.id);
      console.log(`   + opportunity ${oppId} in Enterpryze / ERP Qualified`);
    } catch (err) {
      console.error(`FAILED ${c.firstName} ${c.lastName}: ${err.message}`);
    }
    console.log('');
  }
  console.log('Done.');
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
