'use strict';

const { chromium } = require('playwright');
const fs = require('fs');

const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const BROWSER_CANDIDATES = [
  process.env.PLAYWRIGHT_CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);

async function getSyncValue(key) {
  const res = await fetch(`${APP_URL}/api/sync/${key}`);
  const data = await res.json();
  return data.value || [];
}

async function restoreSyncValue(key, value) {
  await fetch(`${APP_URL}/api/sync/${key}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value, by: 'smoke-test-restore' })
  });
}

async function main() {
  const originalPlanned = await getSyncValue('ap_planned_audits');
  const originalNotifications = await getSyncValue('ap_notifs');
  const executablePath = BROWSER_CANDIDATES.find(p => fs.existsSync(p));
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const issues = [];

  page.on('pageerror', err => issues.push(`pageerror: ${err.message}`));
  page.on('console', msg => {
    if (['error'].includes(msg.type())) issues.push(`console ${msg.type()}: ${msg.text()}`);
  });

  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.fill('#li-u', 'admin');
    await page.fill('#li-p', 'Admin123!');
    await page.click('button:has-text("Sign In")');
    await page.waitForSelector('#app:not(.hidden)', { timeout: 10000 });

    await page.waitForFunction(() => {
      const logo = document.querySelector('#sb-logo');
      return logo && logo.naturalWidth > 0;
    }, null, { timeout: 10000 });

    await page.waitForFunction(() => document.querySelectorAll('svg.lucide').length > 0, null, { timeout: 10000 });

    await page.click('#tbtn');
    await page.waitForSelector('#new-audit-panel', { timeout: 10000 });
    await page.selectOption('#na-dept', { index: 1 });
    await page.click('button:has-text("Preview Full Checklist")');
    await page.waitForSelector('#chk-preview-box:not(.hidden)', { timeout: 10000 });

    await page.click('button:has-text("Create Audit")');
    await page.waitForSelector('#secnav, #cl-area', { timeout: 10000 });

    await page.click('#ni-findings');
    await page.waitForSelector('#ftbody', { timeout: 10000 });
    await page.fill('#dr-from', '2099-01-01');
    await page.fill('#dr-to', '2099-12-31');
    await page.click('#date-range-bar button:has-text("Apply")');
    await page.waitForFunction(() => document.querySelector('#fcnt')?.textContent?.includes('0 record'), null, { timeout: 10000 });
    await page.click('#date-range-bar button:has-text("Clear")');
    await page.waitForFunction(() => !document.querySelector('#fcnt')?.textContent?.includes('0 record'), null, { timeout: 10000 });

    await page.click('#ni-capa');
    await page.waitForSelector('#capa-body', { timeout: 10000 });

    for (const navId of ['dashboard', 'analytics', 'planning', 'execution', 'reports', 'findings', 'capa', 'learnings', 'masterdata', 'adminpanel', 'mytasks', 'mastertracker', 'importdata', 'ocp']) {
      const nav = page.locator(`#ni-${navId}`);
      if (await nav.count()) {
        await nav.click();
        await page.waitForSelector('#mc', { timeout: 10000 });
        await page.waitForTimeout(100);
        const errorBox = await page.locator('#mc:has-text("Page rendering error")').count();
        if (errorBox) issues.push(`rendering error on ${navId}`);
      }
    }

    if (issues.length) {
      throw new Error(issues.join('\n'));
    }

    console.log('Smoke test passed: login, logo/icons, new audit, date filter, findings, CAPA.');
  } finally {
    await browser.close();
    await restoreSyncValue('ap_planned_audits', originalPlanned);
    await restoreSyncValue('ap_notifs', originalNotifications);
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
