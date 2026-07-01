'use strict';
require('dotenv').config();
const { MongoClient } = require('mongodb');

async function main() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || 'onepws_audit');
  const col = db.collection('appdata');

  // Get completed audits (the authoritative source for dates)
  const caRow = await col.findOne({ key: 'ap_completed_audits' });
  const audits = caRow && Array.isArray(caRow.value) ? caRow.value : [];

  // Build a map: auditRef -> submittedAt
  const auditDateMap = {};
  audits.forEach(a => {
    const ref = String(a.ref || a.auditRef || '').trim();
    if (ref) auditDateMap[ref] = a.submittedAt || a.date || '';
  });
  console.log('Audit date map:', JSON.stringify(auditDateMap, null, 2));

  // Get findings
  const findRow = await col.findOne({ key: 'ap_finds' });
  const findings = findRow && Array.isArray(findRow.value) ? findRow.value : [];
  console.log(`\nTotal findings: ${findings.length}`);

  let changed = false;
  const fixedFindings = findings.map(f => {
    if (!f || f.deletedAt) return f;
    const auditRef = String(f.auditRef || '').trim();
    if (!auditRef) return f;

    // If finding already has a date, skip
    const existingDate = f.auditSubmittedAt || f.submittedAt || f.createdAt || f.date || '';
    if (existingDate) return f;

    // Lookup the audit date
    const auditDate = auditDateMap[auditRef];
    if (!auditDate) return f;

    console.log(`  Setting date for ${f.ref} (${f.dept}, auditRef=${auditRef}): ${auditDate}`);
    changed = true;
    return Object.assign({}, f, {
      auditSubmittedAt: auditDate,
      submittedAt: auditDate
    });
  });

  if (changed) {
    await col.updateOne(
      { key: 'ap_finds' },
      { $set: { key: 'ap_finds', value: fixedFindings, updatedAt: new Date(), updatedBy: 'fix-findings-dates' } },
      { upsert: true }
    );
    console.log('\n✅ Updated findings with submittedAt dates in MongoDB');
  } else {
    console.log('\n✅ No findings needed date updates');
  }

  // Also update the test findings (TST-*) - remove them or mark as test
  const withoutTestFindings = fixedFindings.filter(f => {
    if (!f) return false;
    const ref = String(f.ref || '');
    if (ref.startsWith('TST-')) {
      console.log(`  Removing test finding: ${ref}`);
      return false;
    }
    return true;
  });

  if (withoutTestFindings.length !== fixedFindings.length) {
    await col.updateOne(
      { key: 'ap_finds' },
      { $set: { key: 'ap_finds', value: withoutTestFindings, updatedAt: new Date(), updatedBy: 'remove-test-findings' } },
      { upsert: true }
    );
    console.log(`  Removed ${fixedFindings.length - withoutTestFindings.length} test findings`);
  }

  await client.close();
  console.log('\nDone!');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
