'use strict';

require('dotenv').config();
const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || 'onepws_audit';

async function main() {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(MONGODB_DB);
    const collection = db.collection('appdata');
    const doc = await collection.findOne({ key: 'ap_finds' });
    if (!doc) {
      console.log('No ap_finds key found');
      return;
    }
    const findings = doc.value || [];
    
    const cases = ['PRD-2026-047', 'MNT-2026-097'];
    cases.forEach(ref => {
      const f = findings.find(x => x.ref === ref || x.id === ref);
      if (f) {
        console.log(`=== Case: ${ref} ===`);
        console.log(JSON.stringify(f, null, 2));
      } else {
        console.log(`=== Case: ${ref} NOT FOUND ===`);
      }
    });
  } catch (err) {
    console.error(err);
  } finally {
    await client.close();
  }
}
main();
