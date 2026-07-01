'use strict';
require('dotenv').config();
const { MongoClient } = require('mongodb');

// Score calculation (same logic as frontend)
function normalizeSev(sev) {
  const s = String(sev || 'obs').toLowerCase().trim();
  if (s.includes('critical')) return 'critical';
  if (s.includes('major')) return 'major';
  if (s.includes('minor')) return 'minor';
  return 'obs';
}

function calcScore(findings) {
  let c = 0, ma = 0, mi = 0, ob = 0;
  (findings || []).forEach(f => {
    const s = normalizeSev(f.sev || f.severity);
    if (s === 'critical') c++;
    else if (s === 'major') ma++;
    else if (s === 'minor') mi++;
    else ob++;
  });
  const score = 100 - (c * 15) - (ma * 10) - (mi * 5) - (ob * 2);
  return {
    score: Math.min(100, Math.max(0, Math.round(score))),
    counts: { critical: c, major: ma, minor: mi, obs: ob }
  };
}

async function main() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || 'onepws_audit');
  const col = db.collection('appdata');

  // ── 1. Get current completed audits ─────────────────────────
  const caRow = await col.findOne({ key: 'ap_completed_audits' });
  const audits = caRow && Array.isArray(caRow.value) ? caRow.value : [];
  console.log(`\nTotal audits BEFORE fix: ${audits.length}`);

  // ── 2. Get current findings ──────────────────────────────────
  const findRow = await col.findOne({ key: 'ap_finds' });
  const findings = findRow && Array.isArray(findRow.value) ? findRow.value : [];

  // Group findings by auditRef
  const findingsByRef = {};
  findings.forEach(f => {
    if (!f || f.deletedAt) return;
    const ref = String(f.auditRef || '').trim();
    if (!ref) return;
    if (!findingsByRef[ref]) findingsByRef[ref] = [];
    findingsByRef[ref].push(f);
  });
  console.log('Audit refs from findings:', Object.keys(findingsByRef).join(', '));

  // ── 3. Remove all spurious AUTO-PRD duplicates ────────────────
  // Keep only: the real PRD-AUD-2026-5771, and remove all AUTO-PRD-* entries
  // Also remove the wrong AUTO-DES-2026-06-30 entry
  const cleanedAudits = audits.filter(a => {
    if (!a) return false;
    const ref = String(a.ref || a.auditRef || a.id || '');
    // Remove all auto-derived PRD duplicates (timestamp-based IDs)
    if (/^AUTO-PRD-\d+$/.test(ref)) {
      console.log(`  REMOVING duplicate: ${a.dept} ${ref}`);
      return false;
    }
    // Remove wrong auto-derived DES entry (today's one with wrong score)
    if (ref === 'AUTO-DES-2026-06-30') {
      console.log(`  REMOVING wrong auto DES: ${a.dept} ${ref} score=${a.auditScoreFrozen}`);
      return false;
    }
    return true;
  });

  console.log(`\nAudits after removing duplicates: ${cleanedAudits.length}`);

  // ── 4. Fix scores for real audits based on actual findings ────
  const fixedAudits = cleanedAudits.map(a => {
    const ref = String(a.ref || a.auditRef || a.id || '');
    const rows = findingsByRef[ref] || [];
    if (rows.length > 0) {
      const result = calcScore(rows);
      const oldScore = a.auditScoreFrozen;
      console.log(`  Fixing ${a.dept} ${ref}: findings=${rows.length} old_score=${oldScore} -> new_score=${result.score} counts=${JSON.stringify(result.counts)}`);
      return Object.assign({}, a, {
        auditScoreFrozen: result.score,
        auditFindingCountsFrozen: result.counts
      });
    } else {
      console.log(`  Keeping ${a.dept} ${ref}: no matched findings, score=${a.auditScoreFrozen}`);
      return a;
    }
  });

  // ── 5. Save cleaned + fixed completed audits to MongoDB ───────
  await col.updateOne(
    { key: 'ap_completed_audits' },
    { $set: { key: 'ap_completed_audits', value: fixedAudits, updatedAt: new Date(), updatedBy: 'fix-audit-data-script' } },
    { upsert: true }
  );

  console.log(`\n✅ SAVED ${fixedAudits.length} audits to MongoDB`);
  console.log('\nFinal audit list:');
  fixedAudits.forEach(a => {
    console.log(`  ${a.dept.padEnd(5)} ${String(a.ref || '').padEnd(25)} ${String(a.submittedAt || a.date || '').slice(0,10).padEnd(12)} score: ${a.auditScoreFrozen}`);
  });

  // ── 6. Also push local storage backup data to sync keys ───────
  console.log('\n── Syncing local storage backup to DB keys ──');
  const backup = await col.findOne({ key: 'ap_local_storage_backup' });
  const backupData = backup && backup.value && backup.value.data ? backup.value.data : null;
  
  if (backupData) {
    // Keys to sync from local backup to DB (excluding ap_completed_audits which we already fixed)
    const syncableKeys = [
      'ap_users', 'ap_depts', 'ap_auds', 'ap_cps', 'ap_finds', 'ap_learns',
      'ap_planned_audits', 'ap_import_logs', 'ap_capa_due', 'ap_secs', 'ap_notifs',
      'ap_stds', 'ap_permissions', 'ap_email_master', 'ap_email_templates',
      'ap_email_logs', 'ap_required_cc_emails', 'ap_root_causes', 'ap_media_library',
      'ap_escalation_matrix', 'ap_audit_drafts'
    ];

    let syncCount = 0;
    for (const key of syncableKeys) {
      if (!backupData[key]) continue;
      let val = backupData[key];
      if (typeof val === 'string') {
        try { val = JSON.parse(val); } catch (_) { continue; }
      }
      // Check if DB already has this key
      const existing = await col.findOne({ key });
      const existingJson = JSON.stringify(existing && existing.value);
      const newJson = JSON.stringify(val);
      if (existingJson === newJson) {
        console.log(`  SKIP ${key} (unchanged)`);
        continue;
      }
      await col.updateOne(
        { key },
        { $set: { key, value: val, updatedAt: new Date(), updatedBy: 'fix-local-sync' } },
        { upsert: true }
      );
      console.log(`  SYNCED ${key}`);
      syncCount++;
    }
    console.log(`\n✅ Synced ${syncCount} keys from local backup to MongoDB`);
  } else {
    console.log('  No local backup data found');
  }

  await client.close();
  console.log('\nDone!');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
