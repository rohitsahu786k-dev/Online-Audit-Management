'use strict';
require('dotenv').config();
const { MongoClient } = require('mongodb');
async function main() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || 'onepws_audit');
  const col = db.collection('appdata');
  
  // Remove draft_u1 finding which has no dept/sev/status
  const findRow = await col.findOne({ key: 'ap_finds' });
  const finds = findRow && Array.isArray(findRow.value) ? findRow.value : [];
  const cleaned = finds.filter(f => {
    if (!f) return false;
    if (f.ref === 'draft_u1') { console.log('Removing draft_u1'); return false; }
    return true;
  });
  console.log('Removed', finds.length - cleaned.length, 'invalid findings');
  await col.updateOne(
    { key: 'ap_finds' },
    { $set: { key: 'ap_finds', value: cleaned, updatedAt: new Date(), updatedBy: 'remove-draft-findings' } },
    { upsert: true }
  );
  console.log('Total findings now:', cleaned.length);
  await client.close();
}
main().catch(console.error);
