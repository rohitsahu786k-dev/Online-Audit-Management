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
const SMTP_FROM = process.env.SMTP_FROM || (SMTP_USER ? `OnePWS AuditPro <${SMTP_USER}>` : undefined);

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
  'ap_media_library',
  'ap_escalation_matrix'
];
const PASSWORD_RESET_KEY = '_password_reset_otps';

let mongoClient;
let appData;
let mongoConnectPromise;
let mailer;

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

function cleanEnvValue(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '');
}

function getCloudinaryConfig() {
  const url = cleanEnvValue(process.env.CLOUDINARY_URL);
  if (url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'cloudinary:') {
        const cloudName = parsed.hostname || parsed.pathname.replace(/^\/+/, '');
        return {
          apiKey: decodeURIComponent(parsed.username || ''),
          apiSecret: decodeURIComponent(parsed.password || ''),
          cloudName: decodeURIComponent(cloudName || '')
        };
      }
    } catch (_err) {
      const match = url.match(/^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/);
      if (match) {
        return {
          apiKey: decodeURIComponent(match[1]),
          apiSecret: decodeURIComponent(match[2]),
          cloudName: decodeURIComponent(match[3].replace(/[/?#].*$/, ''))
        };
      }
    }
  }

  return {
    cloudName: cleanEnvValue(process.env.CLOUDINARY_CLOUD_NAME),
    apiKey: cleanEnvValue(process.env.CLOUDINARY_API_KEY),
    apiSecret: cleanEnvValue(process.env.CLOUDINARY_API_SECRET)
  };
}

function getCloudinaryEndpoint(cfg, resourceType, action) {
  const cloudName = encodeURIComponent(cfg.cloudName);
  const type = encodeURIComponent(resourceType);
  return `https://api.cloudinary.com/v1_1/${cloudName}/${type}/${action}`;
}

function cloudinarySignature(params, secret) {
  const payload = Object.keys(params)
    .filter(key => params[key] !== undefined && params[key] !== null && params[key] !== '')
    .sort()
    .map(key => `${key}=${params[key]}`)
    .join('&');
  return crypto.createHash('sha1').update(payload + secret).digest('hex');
}

function mediaTypeFromUpload(upload) {
  if (!upload) return 'document';
  if (upload.resource_type === 'image') return 'image';
  if (upload.resource_type === 'video') return 'video';
  if (String(upload.format || '').toLowerCase() === 'pdf') return 'pdf';
  return 'document';
}

async function getMediaRows(collection) {
  const row = await collection.findOne({ key: 'ap_media_library' });
  return Array.isArray(row && row.value) ? row.value : [];
}

async function saveMediaRows(collection, rows, by) {
  const now = new Date();
  await collection.updateOne(
    { key: 'ap_media_library' },
    { $set: { key: 'ap_media_library', value: rows, updatedAt: now, updatedBy: by || 'media' } },
    { upsert: true }
  );
  return { updatedAt: now, value: rows };
}

async function appendMediaRecord(media, by) {
  const collection = await getCollection();
  const rows = await getMediaRows(collection);
  const next = [media].concat(rows.filter(row => row && row.public_id !== media.public_id)).slice(0, 1000);
  await saveMediaRows(collection, next, by || 'media-upload');
  return next;
}

async function destroyCloudinaryAsset(publicId, resourceType) {
  const cfg = getCloudinaryConfig();
  if (!cfg.cloudName || !cfg.apiKey || !cfg.apiSecret) {
    const err = new Error('Cloudinary is not configured');
    err.statusCode = 503;
    throw err;
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const params = { public_id: publicId, timestamp };
  const form = new FormData();
  form.append('public_id', publicId);
  form.append('timestamp', String(timestamp));
  form.append('api_key', cfg.apiKey);
  form.append('signature', cloudinarySignature(params, cfg.apiSecret));

  const type = resourceType || 'image';
  const response = await fetch(getCloudinaryEndpoint(cfg, type, 'destroy'), {
    method: 'POST',
    body: form
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    const err = new Error(data.error && data.error.message ? data.error.message : 'Cloudinary delete failed');
    err.statusCode = response.status || 502;
    throw err;
  }
  return data;
}

function emailLogKey(log) {
  if (!log || typeof log !== 'object') return '';
  if (log.id) return String(log.id);
  return [
    log.type || '',
    log.to || '',
    log.cc || '',
    log.subject || '',
    log.status || '',
    log.sentAt || ''
  ].join('|');
}

function mergeEmailLogs(existing, incoming, clearedAt) {
  const clearTime = clearedAt ? new Date(clearedAt).getTime() : 0;
  const seen = new Set();
  return []
    .concat(Array.isArray(incoming) ? incoming : [], Array.isArray(existing) ? existing : [])
    .filter(log => {
      if (!log || typeof log !== 'object') return false;
      const sentTime = log.sentAt ? new Date(log.sentAt).getTime() : Date.now();
      if (clearTime && sentTime <= clearTime) return false;
      const key = emailLogKey(log);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => new Date(b.sentAt || 0) - new Date(a.sentAt || 0))
    .slice(0, 500);
}

function cleanIdentity(input) {
  return String(input || '').trim().toLowerCase();
}

function hashOtp(userId, otp) {
  return crypto.createHash('sha256').update(`${userId}:${otp}:${SMTP_PASS || 'auditpro'}`).digest('hex');
}

async function getPasswordResetRows(collection) {
  const row = await collection.findOne({ key: PASSWORD_RESET_KEY });
  return Array.isArray(row && row.value) ? row.value : [];
}

async function savePasswordResetOtp(collection, userId, otpHash, expiresAt) {
  const now = Date.now();
  const rows = (await getPasswordResetRows(collection))
    .filter(row => row && row.userId !== userId && Number(row.expiresAt) > now);

  rows.push({ userId, otpHash, expiresAt, attempts: 0 });

  await collection.updateOne(
    { key: PASSWORD_RESET_KEY },
    { $set: { key: PASSWORD_RESET_KEY, value: rows, updatedAt: new Date(), updatedBy: 'password-reset' } },
    { upsert: true }
  );
}

async function updatePasswordResetOtp(collection, userId, patch) {
  const rows = (await getPasswordResetRows(collection)).map(row => (
    row && row.userId === userId ? Object.assign({}, row, patch) : row
  ));

  await collection.updateOne(
    { key: PASSWORD_RESET_KEY },
    { $set: { key: PASSWORD_RESET_KEY, value: rows, updatedAt: new Date(), updatedBy: 'password-reset' } },
    { upsert: true }
  );
}

async function deletePasswordResetOtp(collection, userId) {
  const rows = (await getPasswordResetRows(collection)).filter(row => row && row.userId !== userId);
  await collection.updateOne(
    { key: PASSWORD_RESET_KEY },
    { $set: { key: PASSWORD_RESET_KEY, value: rows, updatedAt: new Date(), updatedBy: 'password-reset' } },
    { upsert: true }
  );
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
  const incomingValue = req.body && Object.prototype.hasOwnProperty.call(req.body, 'value') ? req.body.value : null;

  if (key === 'ap_email_logs') {
    const current = await collection.findOne({ key });
    const replace = Boolean(req.body && req.body.replace);
    const clearedAt = replace && Array.isArray(incomingValue) && incomingValue.length === 0
      ? now
      : (current && current.clearedAt);
    const value = replace
      ? (Array.isArray(incomingValue) ? incomingValue : [])
      : mergeEmailLogs(current && current.value, incomingValue, clearedAt);

    await collection.updateOne(
      { key },
      {
        $set: {
          key,
          value,
          updatedAt: now,
          updatedBy: (req.body && req.body.by) || 'browser',
          clearedAt: clearedAt || null
        }
      },
      { upsert: true }
    );

    return res.json({ ok: true, key, updatedAt: now, count: value.length });
  }

  await collection.updateOne(
    { key },
    {
      $set: {
        key,
        value: incomingValue,
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
  const attachments = Array.isArray(req.body && req.body.attachments)
    ? req.body.attachments
        .filter(item => item && item.url)
        .map(item => ({ filename: String(item.filename || 'attachment'), path: String(item.url) }))
    : [];

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
    html,
    attachments
  });

  res.json({ ok: true, messageId: info.messageId, accepted: info.accepted });
}));

app.post('/api/email/log', wrapAsync(async (req, res) => {
  const log = req.body && req.body.log;
  if (!log || typeof log !== 'object') return res.status(400).json({ ok: false, error: 'Email log is required' });

  const collection = await getCollection();
  const current = await collection.findOne({ key: 'ap_email_logs' });
  const now = new Date();
  const value = mergeEmailLogs(current && current.value, [log], current && current.clearedAt);

  await collection.updateOne(
    { key: 'ap_email_logs' },
    {
      $set: {
        key: 'ap_email_logs',
        value,
        updatedAt: now,
        updatedBy: (req.body && req.body.by) || 'email-log',
        clearedAt: current && current.clearedAt ? current.clearedAt : null
      }
    },
    { upsert: true }
  );

  res.json({ ok: true, count: value.length, value });
}));

app.get('/api/media/status', wrapAsync(async (_req, res) => {
  const cfg = getCloudinaryConfig();
  if (!cfg.cloudName || !cfg.apiKey || !cfg.apiSecret) {
    return res.status(503).json({ ok: false, connected: false, error: 'Cloudinary is not configured' });
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const params = {
    folder: 'onepws-auditpro/health',
    overwrite: 'true',
    public_id: 'connection-test',
    timestamp
  };
  const form = new FormData();
  form.append('file', 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==');
  form.append('folder', params.folder);
  form.append('overwrite', params.overwrite);
  form.append('public_id', params.public_id);
  form.append('timestamp', String(timestamp));
  form.append('api_key', cfg.apiKey);
  form.append('signature', cloudinarySignature(params, cfg.apiSecret));

  const response = await fetch(getCloudinaryEndpoint(cfg, 'auto', 'upload'), {
    method: 'POST',
    body: form
  });
  const upload = await response.json().catch(() => ({}));
  if (!response.ok || upload.error) {
    return res.status(response.status || 502).json({
      ok: false,
      connected: false,
      cloudName: cfg.cloudName,
      error: upload.error && upload.error.message ? upload.error.message : 'Cloudinary connectivity check failed'
    });
  }

  res.json({
    ok: true,
    connected: true,
    cloudName: cfg.cloudName,
    publicId: upload.public_id,
    secureUrl: upload.secure_url
  });
}));

app.post('/api/media/upload', wrapAsync(async (req, res) => {
  const cfg = getCloudinaryConfig();
  if (!cfg.cloudName || !cfg.apiKey || !cfg.apiSecret) {
    return res.status(503).json({ ok: false, error: 'Cloudinary is not configured' });
  }

  const file = String((req.body && req.body.dataUrl) || '');
  const fileName = String((req.body && req.body.fileName) || 'upload').trim();
  const moduleName = String((req.body && req.body.module) || 'general').trim();
  const category = String((req.body && req.body.category) || '').trim();
  const relatedId = String((req.body && req.body.relatedId) || '').trim();
  const dept = String((req.body && req.body.dept) || '').trim();
  const tags = Array.isArray(req.body && req.body.tags) ? req.body.tags.map(String).map(v => v.trim()).filter(Boolean) : [];
  const uploadedBy = String((req.body && req.body.uploadedBy) || 'browser').trim();

  if (!file || !/^data:|^https?:\/\//i.test(file)) {
    return res.status(400).json({ ok: false, error: 'A data URL or URL file is required' });
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const folder = `onepws-auditpro/${moduleName.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase()}`;
  const signed = { folder, timestamp };
  const form = new FormData();
  form.append('file', file);
  form.append('folder', folder);
  form.append('timestamp', String(timestamp));
  form.append('api_key', cfg.apiKey);
  form.append('signature', cloudinarySignature(signed, cfg.apiSecret));

  const response = await fetch(getCloudinaryEndpoint(cfg, 'auto', 'upload'), {
    method: 'POST',
    body: form
  });
  const upload = await response.json().catch(() => ({}));
  if (!response.ok || upload.error) {
    return res.status(response.status || 502).json({ ok: false, error: upload.error && upload.error.message ? upload.error.message : 'Cloudinary upload failed' });
  }

  const media = {
    id: `media_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    file_name: fileName,
    secure_url: upload.secure_url,
    public_id: upload.public_id,
    file_type: mediaTypeFromUpload(upload),
    resource_type: upload.resource_type || '',
    format: upload.format || '',
    bytes: upload.bytes || 0,
    module: moduleName,
    category: category || mediaTypeFromUpload(upload),
    related_id: relatedId,
    dept,
    tags,
    status: 'active',
    uploaded_by: uploadedBy,
    uploaded_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    activity_log: [
      { action: 'uploaded', by: uploadedBy, at: new Date().toISOString(), note: fileName }
    ],
    versions: []
  };

  await appendMediaRecord(media, uploadedBy);
  res.json({ ok: true, media });
}));

app.put('/api/media/:id', wrapAsync(async (req, res) => {
  const collection = await getCollection();
  const rows = await getMediaRows(collection);
  const id = String(req.params.id || '');
  const by = String((req.body && req.body.by) || 'media-update');
  const patch = (req.body && req.body.patch) || {};
  const idx = rows.findIndex(row => row && row.id === id);
  if (idx < 0) return res.status(404).json({ ok: false, error: 'Media record not found' });

  const allowed = ['file_name', 'category', 'tags', 'related_id', 'dept', 'module', 'status', 'secure_url', 'public_id', 'resource_type', 'file_type', 'format', 'bytes', 'versions'];
  const next = Object.assign({}, rows[idx]);
  allowed.forEach(key => {
    if (Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key];
  });
  next.updated_at = new Date().toISOString();
  next.activity_log = Array.isArray(next.activity_log) ? next.activity_log : [];
  next.activity_log.unshift({ action: String(patch.status || 'updated'), by, at: next.updated_at });
  rows[idx] = next;
  await saveMediaRows(collection, rows, by);
  res.json({ ok: true, media: next, value: rows });
}));

app.post('/api/media/:id/delete', wrapAsync(async (req, res) => {
  const collection = await getCollection();
  const rows = await getMediaRows(collection);
  const id = String(req.params.id || '');
  const permanent = Boolean(req.body && req.body.permanent);
  const by = String((req.body && req.body.by) || 'media-delete');
  const idx = rows.findIndex(row => row && row.id === id);
  if (idx < 0) return res.status(404).json({ ok: false, error: 'Media record not found' });
  const media = rows[idx];

  if (permanent) {
    if (media.public_id) await destroyCloudinaryAsset(media.public_id, media.resource_type || (media.file_type === 'video' ? 'video' : 'image'));
    rows.splice(idx, 1);
  } else {
    media.status = 'trash';
    media.deleted_at = new Date().toISOString();
    media.deleted_by = by;
    media.activity_log = Array.isArray(media.activity_log) ? media.activity_log : [];
    media.activity_log.unshift({ action: 'moved_to_trash', by, at: media.deleted_at });
    rows[idx] = media;
  }

  await saveMediaRows(collection, rows, by);
  res.json({ ok: true, value: rows });
}));

app.post('/api/auth/forgot-password', wrapAsync(async (req, res) => {
  const identity = cleanIdentity(req.body && req.body.identity);
  if (!identity) return res.status(400).json({ ok: false, error: 'Login ID or email is required' });

  const { collection, users } = await getUsersRecord();
  const user = findUserByIdentity(users, identity);
  if (!user || !user.email) {
    return res.status(404).json({ ok: false, error: 'No active account found with a registered email' });
  }

  const otp = String(crypto.randomInt(100000, 1000000));
  await savePasswordResetOtp(collection, user.id, hashOtp(user.id, otp), Date.now() + (15 * 60 * 1000));

  const transport = getMailer();
  const subject = 'OnePWS AuditPro password reset OTP';
  const text = [
    `Hello ${user.name || user.loginId},`,
    '',
    `Your OnePWS AuditPro password reset OTP is ${otp}.`,
    'This OTP is valid for 15 minutes.',
    '',
    'If you did not request this reset, please ignore this email.'
  ].join('\n');
  const html = `<p>Hello ${user.name || user.loginId},</p><p>Your OnePWS AuditPro password reset OTP is <strong style="font-size:18px;letter-spacing:3px;">${otp}</strong>.</p><p>This OTP is valid for 15 minutes.</p><p>If you did not request this reset, please ignore this email.</p>`;

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

  const resets = await getPasswordResetRows(collection);
  const reset = resets.find(row => row && row.userId === user.id);
  if (!reset || reset.expiresAt < Date.now()) {
    await deletePasswordResetOtp(collection, user.id);
    return res.status(400).json({ ok: false, error: 'OTP expired. Please request a new OTP' });
  }

  reset.attempts += 1;
  if (reset.attempts > 5) {
    await deletePasswordResetOtp(collection, user.id);
    return res.status(429).json({ ok: false, error: 'Too many OTP attempts. Please request a new OTP' });
  }
  await updatePasswordResetOtp(collection, user.id, { attempts: reset.attempts });

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
  await deletePasswordResetOtp(collection, user.id);

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

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[AuditPro] Server running on port ${PORT}`);
  });
}

module.exports = app;
