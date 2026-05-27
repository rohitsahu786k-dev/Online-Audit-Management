'use strict';

const { chromium } = require('playwright');
const fs = require('fs');

const APP_URL = process.env.APP_URL;
const BROWSER_CANDIDATES = [
  process.env.PLAYWRIGHT_CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);

if (!APP_URL) {
  throw new Error('APP_URL is required. Set it to the deployed app URL or the local dev server URL before running smoke tests.');
}

async function api(path, opts) {
  const res = await fetch(`${APP_URL}${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function getSyncValue(key) {
  const data = await api(`/api/sync/${key}`);
  return data.value || [];
}

async function restoreSyncValue(key, value) {
  await api(`/api/sync/${key}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value, by: 'smoke-test-restore' })
  });
}

async function clickNav(page, navId) {
  const nav = page.locator(`#ni-${navId}`);
  if (!(await nav.count())) return false;
  await nav.click();
  await page.waitForSelector('#mc', { timeout: 10000 });
  await page.waitForTimeout(150);
  return true;
}

async function main() {
  const health = await api('/api/health');
  if (!health.mongo) throw new Error('MongoDB health check is offline');

  const favicon = await fetch(`${APP_URL}/favicon.ico`);
  if (!favicon.ok || !String(favicon.headers.get('content-type') || '').includes('image/png')) {
    throw new Error('Favicon route is not serving image/png');
  }

  const originalPlanned = await getSyncValue('ap_planned_audits');
  const originalNotifications = await getSyncValue('ap_notifs');
  const executablePath = BROWSER_CANDIDATES.find(p => fs.existsSync(p));
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const issues = [];

  page.on('pageerror', err => issues.push(`pageerror: ${err.message}`));
  page.on('console', msg => {
    if (['error', 'warning'].includes(msg.type())) issues.push(`console ${msg.type()}: ${msg.text()}`);
  });
  page.on('requestfailed', req => issues.push(`request failed: ${req.url()} ${req.failure()?.errorText || ''}`));

  try {
    await page.goto(APP_URL, { waitUntil: 'networkidle' });
    await page.evaluate(() => {
      localStorage.removeItem('ap_cu');
      localStorage.removeItem('ap_planned_audits');
      localStorage.removeItem('ap_active_audit');
      localStorage.removeItem('ap_sess');
    });
    await page.reload({ waitUntil: 'networkidle' });

    const beforeType = await page.locator('#li-p').getAttribute('type');
    await page.click('#pw-toggle');
    const afterType = await page.locator('#li-p').getAttribute('type');
    if (beforeType !== 'password' || afterType !== 'text') issues.push('Password visibility toggle did not switch input type');

    await page.click('#forgot-btn');
    if (!(await page.locator('#m-forgot:not(.hidden)').isVisible())) issues.push('Forgot password modal did not open');
    await page.keyboard.press('Escape');

    await page.fill('#li-u', 'admin');
    await page.fill('#li-p', 'Admin123!');
    await page.click('button:has-text("Sign In")');
    await page.waitForSelector('#app:not(.hidden)', { timeout: 10000 });
    await page.waitForFunction(() => (document.querySelector('#sync-indicator')?.textContent || '').includes('Synced'), null, { timeout: 20000 });

    await page.waitForFunction(() => {
      const logo = document.querySelector('#sb-logo');
      return logo && logo.naturalWidth > 0;
    }, null, { timeout: 10000 });
    await page.waitForFunction(() => document.querySelectorAll('svg.lucide').length > 0, null, { timeout: 10000 });

    await clickNav(page, 'planning');
    await page.waitForSelector('#cal-grid', { timeout: 10000 });
    await page.selectOption('#na-dept', { index: 1 });
    await page.selectOption('#na-aud', { index: 0 });
    await page.fill('#na-date', '2026-05-26');
    await page.click('#schedule-audit-btn');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('ap_planned_audits') || '[]').length === 1, null, { timeout: 10000 });
    if (!(await page.locator('#planning-list').innerText()).includes('Pre-Sales')) issues.push('Scheduled audit did not appear in planning list');
    if (!/audit/i.test(await page.locator('#cal-grid').innerText())) issues.push('Scheduled audit did not appear on calendar');

    await page.click('#planning-list button:has-text("Start")');
    await page.waitForSelector('#ptitle:text("Audit Execution")', { timeout: 10000 });
    await page.waitForSelector('#cl-area .cq', { timeout: 10000 });
    await page.locator('#cl-area .abtn', { hasText: /Yes/ }).first().click();

    for (const navId of ['dashboard', 'analytics', 'planning', 'execution', 'reports', 'findings', 'capa', 'learnings', 'masterdata', 'adminpanel', 'mytasks', 'managerpanel', 'mastertracker', 'importdata', 'ocp']) {
      const visited = await clickNav(page, navId);
      if (!visited) continue;
      const errorBox = await page.locator('#mc:has-text("Page rendering error")').count();
      if (errorBox) issues.push(`rendering error on ${navId}`);
    }

    if (issues.length) throw new Error(issues.join('\n'));

    console.log('Smoke test passed: favicon, login controls, sync, planning calendar, execution, and module rendering.');
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
