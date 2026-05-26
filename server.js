'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const nodemailer = require('nodemailer');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || 'onepws_audit';
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_SECURE = String(process.env.SMTP_SECURE || 'true').toLowerCase() === 'true';
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || (SMTP_USER ? `ONEPWS AuditPro <${SMTP_USER}>` : undefined);

const SYNC_KEYS = [
  'ap_users',
  'ap_depts',
  'ap_auds',
  'ap_cps',
  'ap_finds',
  'ap_learns',
  'ap_completed_audits',
  'ap_planned_audits',
  'ap_import_logs',
  'ap_capa_due',
  'ap_secs',
  'ap_notifs',
  'ap_stds',
  'ap_email_master',
  'ap_email_templates',
  'ap_email_logs',
  'ap_escalation_matrix'
];

let mongoClient;
let appData;
let mongoConnectPromise;
let mailer;
const passwordResetOtps = new Map();

app.use(express.json({ limit: '50mb' }));

app.get('/favicon.ico', (_req, res) => {
  res.type('image/png').sendFile(path.join(__dirname, 'assets', 'favicon.png'));
});

function assertSyncKey(key) {
  if (!SYNC_KEYS.includes(key)) {
    const err = new Error(`Unsupported sync key: ${key}`);
    err.statusCode = 400;
    throw err;
  }
}

async function getCollection() {
  if (!MONGODB_URI) {
    const err = new Error('MONGODB_URI is not configured');
    err.statusCode = 503;
    throw err;
  }

  if (appData) return appData;

  if (!mongoConnectPromise) {
    mongoConnectPromise = (async () => {
      mongoClient = new MongoClient(MONGODB_URI);
      await mongoClient.connect();
      const db = mongoClient.db(MONGODB_DB);
      appData = db.collection('appdata');
      await appData.createIndex({ key: 1 }, { unique: true });
      console.log(`[AuditPro] MongoDB connected: ${MONGODB_DB}.appdata`);
      return appData;
    })().catch(err => {
      mongoClient = null;
      appData = null;
      mongoConnectPromise = null;
      throw err;
    });
  }

  return mongoConnectPromise;
}

function getMailer() {
  if (!SMTP_USER || !SMTP_PASS) {
    const err = new Error('SMTP_USER or SMTP_PASS is not configured');
    err.statusCode = 503;
    throw err;
  }

  if (!mailer) {
    mailer = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASS
      }
    });
  }

  return mailer;
}

function parseRecipients(input) {
  if (Array.isArray(input)) return input.map(String).map(v => v.trim()).filter(Boolean);
  if (typeof input === 'string') {
    return input.split(/[;,]/).map(v => v.trim()).filter(Boolean);
  }
  return [];
}

function cleanIdentity(input) {
  return String(input || '').trim().toLowerCase();
}

function hashOtp(userId, otp) {
  return crypto.createHash('sha256').update(`${userId}:${otp}:${SMTP_PASS || 'auditpro'}`).digest('hex');
}

async function getUsersRecord() {
  const collection = await getCollection();
  const row = await collection.findOne({ key: 'ap_users' });
  return { collection, users: Array.isArray(row && row.value) ? row.value : [] };
}

function findUserByIdentity(users, identity) {
  const needle = cleanIdentity(identity);
  if (!needle) return null;
  return users.find(user => {
    if (!user || user.active === false) return false;
    return cleanIdentity(user.loginId) === needle || cleanIdentity(user.email) === needle;
  }) || null;
}

function wrapAsync(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

app.get('/api/health', wrapAsync(async (_req, res) => {
  let mongo = false;
  try {
    await getCollection();
    mongo = true;
  } catch (err) {
    mongo = false;
  }

  res.json({
    ok: true,
    mongo,
    smtp: Boolean(SMTP_USER && SMTP_PASS),
    dbName: MONGODB_DB
  });
}));

app.get('/api/sync/keys', (_req, res) => {
  res.json({ ok: true, keys: SYNC_KEYS });
});

app.get('/api/sync', wrapAsync(async (_req, res) => {
  const collection = await getCollection();
  const rows = await collection.find({ key: { $in: SYNC_KEYS } }).toArray();
  const data = {};
  rows.forEach(row => {
    data[row.key] = {
      value: row.value,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy || 'system'
    };
  });
  res.json({ ok: true, data });
}));

app.get('/api/sync/:key', wrapAsync(async (req, res) => {
  const { key } = req.params;
  assertSyncKey(key);
  const collection = await getCollection();
  const row = await collection.findOne({ key });
  res.json({ ok: true, key, value: row ? row.value : null, updatedAt: row ? row.updatedAt : null });
}));

app.put('/api/sync/:key', wrapAsync(async (req, res) => {
  const { key } = req.params;
  assertSyncKey(key);

  const collection = await getCollection();
  const now = new Date();
  await collection.updateOne(
    { key },
    {
      $set: {
        key,
        value: req.body && Object.prototype.hasOwnProperty.call(req.body, 'value') ? req.body.value : null,
        updatedAt: now,
        updatedBy: (req.body && req.body.by) || 'browser'
      }
    },
    { upsert: true }
  );

  res.json({ ok: true, key, updatedAt: now });
}));

app.post('/api/sync/bulk', wrapAsync(async (req, res) => {
  const items = (req.body && req.body.items) || {};
  const keys = Object.keys(items).filter(key => SYNC_KEYS.includes(key));
  if (!keys.length) return res.json({ ok: true, count: 0 });

  const collection = await getCollection();
  const now = new Date();
  await collection.bulkWrite(keys.map(key => ({
    updateOne: {
      filter: { key },
      update: {
        $set: {
          key,
          value: items[key],
          updatedAt: now,
          updatedBy: (req.body && req.body.by) || 'browser'
        }
      },
      upsert: true
    }
  })));

  res.json({ ok: true, count: keys.length, updatedAt: now });
}));

app.delete('/api/sync/:key', wrapAsync(async (req, res) => {
  const { key } = req.params;
  assertSyncKey(key);
  const collection = await getCollection();
  await collection.deleteOne({ key });
  res.json({ ok: true, key });
}));

app.delete('/api/sync', wrapAsync(async (_req, res) => {
  const collection = await getCollection();
  const result = await collection.deleteMany({ key: { $in: SYNC_KEYS } });
  res.json({ ok: true, deletedCount: result.deletedCount });
}));

app.get('/api/email/verify', wrapAsync(async (_req, res) => {
  const transport = getMailer();
  const verified = await transport.verify();
  res.json({ ok: true, smtp: Boolean(verified), user: SMTP_USER });
}));

app.post('/api/email', wrapAsync(async (req, res) => {
  const to = parseRecipients(req.body && req.body.to);
  const cc = parseRecipients(req.body && req.body.cc);
  const bcc = parseRecipients(req.body && req.body.bcc);
  const subject = String((req.body && req.body.subject) || '').trim();
  const text = String((req.body && req.body.text) || '').trim();
  const html = req.body && req.body.html ? String(req.body.html) : undefined;

  if (!to.length) return res.status(400).json({ ok: false, error: 'At least one recipient is required' });
  if (!subject) return res.status(400).json({ ok: false, error: 'Subject is required' });
  if (!text && !html) return res.status(400).json({ ok: false, error: 'Email body is required' });

  const transport = getMailer();
  const info = await transport.sendMail({
    from: SMTP_FROM,
    to,
    cc,
    bcc,
    subject,
    text,
    html
  });

  res.json({ ok: true, messageId: info.messageId, accepted: info.accepted });
}));

app.post('/api/auth/forgot-password', wrapAsync(async (req, res) => {
  const identity = cleanIdentity(req.body && req.body.identity);
  if (!identity) return res.status(400).json({ ok: false, error: 'Login ID or email is required' });

  const { users } = await getUsersRecord();
  const user = findUserByIdentity(users, identity);
  if (!user || !user.email) {
    return res.status(404).json({ ok: false, error: 'No active account found with a registered email' });
  }

  const otp = String(crypto.randomInt(100000, 1000000));
  passwordResetOtps.set(user.id, {
    otpHash: hashOtp(user.id, otp),
    expiresAt: Date.now() + (15 * 60 * 1000),
    attempts: 0
  });

  const transport = getMailer();
  const subject = 'ONEPWS AuditPro password reset OTP';
  const text = [
    `Hello ${user.name || user.loginId},`,
    '',
    `Your ONEPWS AuditPro password reset OTP is ${otp}.`,
    'This OTP is valid for 15 minutes.',
    '',
    'If you did not request this reset, please ignore this email.'
  ].join('\n');
  const html = `<p>Hello ${user.name || user.loginId},</p><p>Your ONEPWS AuditPro password reset OTP is <strong style="font-size:18px;letter-spacing:3px;">${otp}</strong>.</p><p>This OTP is valid for 15 minutes.</p><p>If you did not request this reset, please ignore this email.</p>`;

  await transport.sendMail({
    from: SMTP_FROM,
    to: user.email,
    subject,
    text,
    html
  });

  res.json({ ok: true, maskedEmail: user.email.replace(/^(.).+(@.+)$/, '$1***$2') });
}));

app.post('/api/auth/reset-password', wrapAsync(async (req, res) => {
  const identity = cleanIdentity(req.body && req.body.identity);
  const otp = String((req.body && req.body.otp) || '').trim();
  const password = String((req.body && req.body.password) || '');
  if (!identity || !otp || !password) return res.status(400).json({ ok: false, error: 'Identity, OTP and new password are required' });
  if (password.length < 6) return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters' });

  const { collection, users } = await getUsersRecord();
  const user = findUserByIdentity(users, identity);
  if (!user) return res.status(404).json({ ok: false, error: 'No active account found' });

  const reset = passwordResetOtps.get(user.id);
  if (!reset || reset.expiresAt < Date.now()) {
    passwordResetOtps.delete(user.id);
    return res.status(400).json({ ok: false, error: 'OTP expired. Please request a new OTP' });
  }

  reset.attempts += 1;
  if (reset.attempts > 5) {
    passwordResetOtps.delete(user.id);
    return res.status(429).json({ ok: false, error: 'Too many OTP attempts. Please request a new OTP' });
  }

  if (reset.otpHash !== hashOtp(user.id, otp)) {
    return res.status(400).json({ ok: false, error: 'Invalid OTP' });
  }

  const nextUsers = users.map(row => row && row.id === user.id ? Object.assign({}, row, { password }) : row);
  const now = new Date();
  await collection.updateOne(
    { key: 'ap_users' },
    { $set: { key: 'ap_users', value: nextUsers, updatedAt: now, updatedBy: 'password-reset' } },
    { upsert: true }
  );
  passwordResetOtps.delete(user.id);

  res.json({ ok: true, userId: user.id, loginId: user.loginId, updatedAt: now });
}));

app.use(express.static(__dirname));

app.use((err, _req, res, _next) => {
  const status = err.statusCode || 500;
  console.error('[AuditPro API]', err.message);
  res.status(status).json({ ok: false, error: err.message });
});

async function shutdown() {
  if (mongoClient) await mongoClient.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

app.listen(PORT, () => {
  console.log(`[AuditPro] Server running at http://localhost:${PORT}`);
});
