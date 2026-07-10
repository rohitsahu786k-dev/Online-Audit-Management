'use strict';

const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { chromium } = require('playwright');

const BROWSER_CANDIDATES = [
  process.env.PLAYWRIGHT_CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);

async function main() {
  const executablePath = BROWSER_CANDIDATES.find(p => fs.existsSync(p));
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage();

  try {
    const fileUrl = 'file:///' + path.resolve(__dirname, '..', 'public', 'index.html').replace(/\\/g, '/');
    await page.goto(fileUrl, { waitUntil: 'domcontentloaded' });

    const result = await page.evaluate(() => {
      function clone(obj) {
        return JSON.parse(JSON.stringify(obj));
      }

      function check(condition, message) {
        if (!condition) throw new Error(message);
      }

      const submitted = {
        id: 'find_DES_2026_002',
        ref: 'DES-2026-002',
        status: 'pending-closure',
        capaStatus: 'submitted',
        closureEvidence: 'Testing',
        closureSubmittedBy: 'Dept SPOC',
        closureDate: '01 Jul 2026',
        closureSubmittedAt: '2026-07-01T04:30:00.000Z',
        updatedAt: '2026-07-01T04:30:00.000Z',
        activityLog: [
          { user: 'Dept SPOC', action: 'Submitted for review', ts: '01 Jul 2026, 10:00 am' }
        ]
      };

      check(findingWorkflowStatus(submitted) === 'pending-closure', 'SPOC submission must show Submit For Review');
      check(_hasUnreviewedClosureSubmission(submitted), 'SPOC submission should be unreviewed before auditor action');

      const reopened = clone(submitted);
      reopened.status = 'in-progress';
      reopened.capaStatus = 'in-progress';
      reopened.decision = 'reject';
      reopened.decisionComments = 'Needs correction';
      reopened.decisionDate = '01 Jul 2026, 10:30 am';
      reopened.decisionAt = '2026-07-01T05:00:00.000Z';
      reopened.statusChangedAt = '2026-07-01T05:00:00.000Z';
      reopened.updatedAt = '2026-07-01T05:00:00.000Z';
      reopened.activityLog.push({ user: 'Auditor', action: 'Closure REJECTED — Needs correction', ts: '01 Jul 2026, 10:30 am' });

      check(findingWorkflowStatus(reopened) === 'in-progress', 'Rejected CAPA must move to In Process, not stay Submit For Review');
      check(!_hasUnreviewedClosureSubmission(reopened), 'Auditor reject should supersede old closure submission');
      check(_chooseFindingForSync(reopened, submitted).status === 'in-progress', 'Sync must keep newer local In Process over stale pending remote');
      check(_chooseFindingForSync(submitted, reopened).status === 'in-progress', 'Sync must keep newer remote In Process over stale pending local');

      const manualOpen = clone(submitted);
      manualOpen.status = 'open';
      manualOpen.capaStatus = 'open';
      manualOpen.statusChangedAt = '2026-07-01T05:15:00.000Z';
      manualOpen.updatedAt = '2026-07-01T05:15:00.000Z';
      manualOpen.activityLog.push({ user: 'Auditor', action: 'Status -> Open', ts: '01 Jul 2026, 10:45 am' });
      check(_chooseFindingForSync(manualOpen, submitted).status === 'open', 'Manual Open status timestamp must beat older pending submission');

      const delayedReviewed = clone(reopened);
      delayedReviewed.status = 'delayed';
      delayedReviewed.capaStatus = 'delayed';
      check(findingWorkflowStatus(delayedReviewed) === 'delayed', 'Delayed reviewed CAPA must not re-enter Submit For Review');

      const helperCase = clone(submitted);
      supersedeClosureSubmissionForStatus(helperCase, 'open', 'Regression test reopen');
      check(helperCase.decision === 'reject', 'Reopen helper should stamp reject decision');
      check(!_hasUnreviewedClosureSubmission(helperCase), 'Reopen helper should clear unreviewed submission state');

      // Reproduces the production bug: closureDate stored as ambiguous en-IN "DD/MM/YYYY"
      // (e.g. "08/07/2026" = 8 Jul) was being misread by Date.parse() as US "MM/DD/YYYY"
      // (7 Aug), landing AFTER the auditor's real reject decision and permanently
      // resurrecting the finding back to "Submit For Review" on every sync/reload.
      check(_parseAuditTimestamp('08/07/2026') < _parseAuditTimestamp('09 Jul 2026, 5:44 pm'),
        'Ambiguous D/M/Y closureDate must parse as 8 Jul, not misread as 7 Aug');

      const ambiguousDateCase = {
        id: 'find_DES_2026_003',
        ref: 'DES-2026-003',
        status: 'in-progress',
        capaStatus: 'in-progress',
        closureEvidence: 'Updated Production file check list',
        closureSubmittedBy: 'Dept SPOC',
        closureDate: '08/07/2026',
        closureSubmittedAt: '2026-07-08T07:34:00.000Z',
        decision: 'reject',
        decisionComments: 'Needs correction',
        decisionDate: '09 Jul 2026, 5:44 pm',
        decisionAt: '2026-07-09T12:14:00.000Z',
        statusChangedAt: '2026-07-09T12:14:00.000Z',
        updatedAt: '2026-07-09T12:14:00.000Z',
        activityLog: [
          { user: 'Dept SPOC', action: 'Submitted for review', ts: '08 Jul 2026, 1:04 pm' },
          { user: 'Auditor', action: 'Closure REJECTED — Needs correction', ts: '09 Jul 2026, 5:44 pm' }
        ]
      };
      check(!_hasUnreviewedClosureSubmission(ambiguousDateCase), 'Reject must stick even with ambiguous D/M/Y closureDate');
      check(findingWorkflowStatus(ambiguousDateCase) === 'in-progress', 'Ambiguous-date case must show In Process, not Submit For Review');
      // Simulate the record going overdue and re-syncing/reloading repeatedly — it must not resurrect.
      const overdueCopy = clone(ambiguousDateCase);
      overdueCopy.status = 'delayed';
      overdueCopy.capaStatus = 'delayed';
      for (let i = 0; i < 3; i++) {
        const normalized = normalizeFindingSyncObject(overdueCopy);
        check(normalized.status !== 'pending-closure', 'Overdue+reviewed finding must not resurrect to Submit For Review across repeated syncs (pass ' + i + ')');
        check(normalized.decision === 'reject', 'Reject decision must survive repeated sync passes (pass ' + i + ')');
      }

      return 'CAPA status regression checks passed';
    });

    console.log(result);
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
