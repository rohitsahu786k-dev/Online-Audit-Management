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
      reopened.status = 'open';
      reopened.capaStatus = 'open';
      reopened.decision = 'reject';
      reopened.decisionComments = 'Needs correction';
      reopened.decisionDate = '01 Jul 2026, 10:30 am';
      reopened.decisionAt = '2026-07-01T05:00:00.000Z';
      reopened.statusChangedAt = '2026-07-01T05:00:00.000Z';
      reopened.updatedAt = '2026-07-01T05:00:00.000Z';
      reopened.activityLog.push({ user: 'Auditor', action: 'Status -> Open', ts: '01 Jul 2026, 10:30 am' });

      check(findingWorkflowStatus(reopened) === 'open', 'Auditor-reopened CAPA must stay Open');
      check(!_hasUnreviewedClosureSubmission(reopened), 'Auditor reopen should supersede old closure submission');
      check(_chooseFindingForSync(reopened, submitted).status === 'open', 'Sync must keep newer local Open over stale pending remote');
      check(_chooseFindingForSync(submitted, reopened).status === 'open', 'Sync must keep newer remote Open over stale pending local');

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
