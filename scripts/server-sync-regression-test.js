'use strict';

const assert = require('assert');
const app = require('../server');

const {
  parseAuditTimestamp,
  normalizeFindingSyncState,
  mergeFindingsForSync
} = app._syncTest;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const submitted = {
  id: 'find_DES_2026_003',
  ref: 'DES-2026-003',
  status: 'pending-closure',
  capaStatus: 'submitted',
  closureEvidence: 'Updated Production file check list',
  closureSubmittedBy: 'Dept SPOC',
  closureDate: '08/07/2026',
  closureSubmittedAt: '2026-07-08T07:34:00.000Z',
  updatedAt: '2026-07-08T07:34:00.000Z',
  activityLog: [
    { user: 'Dept SPOC', action: 'Submitted for review', ts: '08 Jul 2026, 1:04 pm' }
  ]
};

const rejected = {
  ...clone(submitted),
  status: 'in-progress',
  capaStatus: 'in-progress',
  decision: 'reject',
  decisionComments: 'Needs correction',
  decisionDate: '09 Jul 2026, 5:44 pm',
  decisionAt: '2026-07-09T12:14:00.000Z',
  statusChangedAt: '2026-07-09T12:14:00.000Z',
  updatedAt: '2026-07-09T12:14:00.000Z',
  activityLog: submitted.activityLog.concat([
    { user: 'Auditor', action: 'Closure REJECTED — Needs correction', ts: '09 Jul 2026, 5:44 pm' }
  ])
};

assert(
  parseAuditTimestamp('08/07/2026') < parseAuditTimestamp('09 Jul 2026, 5:44 pm'),
  'Server must parse ambiguous slash dates as en-IN D/M/Y'
);

for (const [current, incoming] of [[submitted, rejected], [rejected, submitted]]) {
  const merged = mergeFindingsForSync([clone(current)], [clone(incoming)])[0];
  assert.strictEqual(merged.status, 'in-progress', 'Server sync must preserve the rejected In Process state');
  assert.strictEqual(merged.capaStatus, 'in-progress', 'Server sync must preserve the rejected CAPA state');
  assert.strictEqual(merged.decision, 'reject', 'Server sync must preserve the rejection decision');
}

const legacyPendingReject = normalizeFindingSyncState({
  ...clone(rejected),
  status: 'pending-closure',
  capaStatus: 'submitted'
});
assert.strictEqual(legacyPendingReject.status, 'in-progress', 'A reviewed rejection must repair to In Process');
assert.strictEqual(legacyPendingReject.capaStatus, 'in-progress', 'A reviewed rejection CAPA must repair to In Process');

console.log('Server CAPA sync regression checks passed');
