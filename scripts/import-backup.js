'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || 'onepws_audit';

const BACKUP_TO_SYNC_KEY = {
  users: 'ap_users',
  depts: 'ap_depts',
  auditors: 'ap_auds',
  checkpoints: 'ap_cps',
  findings: 'ap_finds',
  learnings: 'ap_learns',
  completedAudits: 'ap_completed_audits',
  plannedAudits: 'ap_planned_audits',
  importLogs: 'ap_import_logs',
  notifications: 'ap_notifs',
  sections: 'ap_secs',
  standards: 'ap_stds'
};

function findDefaultBackup() {
  return fs.readdirSync(process.cwd())
    .filter(name => /^OnePWS_Backup_.*\.json$/i.test(name))
    .sort()
    .pop();
}

function uniqueFindingId(f, idx, seen) {
  const base = String((f && f.ref) || (f && f.id) || `finding_${idx}`)
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || `finding_${idx}`;
  let id = `find_${base}`;
  let n = 2;
  while (seen.has(id)) {
    id = `find_${base}_${n}`;
    n += 1;
  }
  seen.add(id);
  return id;
}

function normalizeFindings(data) {
  if (!Array.isArray(data)) return [];
  const seen = new Set();
  return data.map((raw, idx) => {
    const f = raw && typeof raw === 'object' ? { ...raw } : {};
    const id = String(f.id || '').trim();
    if (!id || seen.has(id)) f.id = uniqueFindingId(f, idx, seen);
    else seen.add(id);
    if (!String(f.ref || '').trim()) f.ref = f.id;
    if (!String(f.status || '').trim()) f.status = 'open';
    if (!String(f.capaStatus || '').trim()) f.capaStatus = f.status;
    if (f.clause !== undefined && typeof f.clause !== 'string') f.clause = String(f.clause || '-');
    if (f.closureEvidence == null) f.closureEvidence = '';
    if (!Array.isArray(f.closureFiles)) f.closureFiles = [];
    if (!Array.isArray(f.activityLog)) f.activityLog = [];
    return f;
  });
}

async function main() {
  if (!MONGODB_URI) throw new Error('MONGODB_URI is not configured in .env');

  const backupArg = process.argv[2] || findDefaultBackup();
  if (!backupArg) throw new Error('No backup JSON found. Pass a file path: npm run import:backup -- backup.json');

  const backupPath = path.resolve(process.cwd(), backupArg);
  const raw = fs.readFileSync(backupPath, 'utf8');
  const backup = JSON.parse(raw);

  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const collection = client.db(MONGODB_DB).collection('appdata');
  await collection.createIndex({ key: 1 }, { unique: true });

  const now = new Date();
  const ops = [];
  for (const [backupKey, syncKey] of Object.entries(BACKUP_TO_SYNC_KEY)) {
    if (!Object.prototype.hasOwnProperty.call(backup, backupKey)) continue;
    const value = syncKey === 'ap_finds' ? normalizeFindings(backup[backupKey]) : backup[backupKey];
    ops.push({
      updateOne: {
        filter: { key: syncKey },
        update: {
          $set: {
            key: syncKey,
            value,
            updatedAt: now,
            updatedBy: 'backup-import'
          }
        },
        upsert: true
      }
    });
  }

  if (ops.length) await collection.bulkWrite(ops);
  await client.close();

  console.log(`Imported ${ops.length} dataset(s) from ${path.basename(backupPath)} into ${MONGODB_DB}.appdata`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
