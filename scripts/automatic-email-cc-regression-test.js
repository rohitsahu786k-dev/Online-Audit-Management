'use strict';

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const BROWSER_CANDIDATES = [
  process.env.PLAYWRIGHT_CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);

async function main() {
  const executablePath = BROWSER_CANDIDATES.find(candidate => fs.existsSync(candidate));
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage();

  try {
    const fileUrl = 'file:///' + path.resolve(__dirname, '..', 'public', 'index.html').replace(/\\/g, '/');
    await page.goto(fileUrl, { waitUntil: 'domcontentloaded' });

    const result = await page.evaluate(() => {
      const manager = 'design.manager@example.com';
      const hod = 'design.hod@example.com';
      const spoc = 'design.spoc@example.com';

      APP.depts = [{ code: 'DES', name: 'Design' }];
      APP.users = [];
      APP.emailMaster = [{
        id: 'em_design',
        spocName: 'Design SPOC',
        email: spoc,
        deptCode: 'DES',
        department: 'Design',
        reportingName: 'Design Manager',
        reportingEmail: manager,
        hodEmail: hod,
        managementEmail: 'management@example.com',
        status: 'active'
      }];
      APP.escalationMatrix = [{
        label: 'Escalation',
        min: 0,
        max: 9999,
        frequencyDays: 1,
        to: ['spoc'],
        cc: []
      }];

      ['upcoming_reminder', 'delayed', 'escalation', 'audit'].forEach(mode => {
        const recipients = recipientsForDept('Design', mode, 10);
        if (!recipients.cc.includes(manager)) throw new Error(mode + ' automatic email omitted department Manager');
        if (!recipients.cc.includes(hod)) throw new Error(mode + ' automatic email omitted department HOD/BUH');
        if (recipients.cc.filter(email => email === manager).length !== 1) throw new Error(mode + ' duplicated Manager CC');
        if (recipients.cc.filter(email => email === hod).length !== 1) throw new Error(mode + ' duplicated HOD/BUH CC');
      });

      return 'Automatic email department CC regression checks passed';
    });

    console.log(result);
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
