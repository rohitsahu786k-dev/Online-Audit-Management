'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
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
const AUTH_TOKEN_TTL_MS = Number(process.env.AUTH_TOKEN_TTL_MS || 7 * 24 * 60 * 60 * 1000);
const AUTH_SECRET = process.env.AUTH_SECRET || process.env.SESSION_SECRET || crypto.createHash('sha256')
  .update([MONGODB_DB, 'onepws-auditpro-auth-v2'].join('|'))
  .digest('hex');
const PASSWORD_HASH_ITERATIONS = Number(process.env.PASSWORD_HASH_ITERATIONS || 120000);
const REQUIRED_SYNC_CLIENT = 'AuditPro-Web/2026-07-02-sync-guard-2';
const SYNC_READ_THROTTLE_MS = 20 * 1000;

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
  'ap_permissions',
  'ap_email_master',
  'ap_email_templates',
  'ap_email_logs',
  'ap_required_cc_emails',
  'ap_root_causes',
  'ap_media_library',
  'ap_escalation_matrix',
  'ap_audit_drafts',
  'ap_local_storage_backup'
];
const PASSWORD_RESET_KEY = '_password_reset_otps';
const EMAIL_SEND_LOCK_PREFIX = '_email_send_lock_';
const EMAIL_LOCK_PENDING_MS = 10 * 60 * 1000;

let mongoClient;
let appData;
let mongoConnectPromise;
let mailer;
const recentSyncReads = new Map();

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});

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

function stableSyncStringify(value) {
  if (value === undefined) return '"__undefined__"';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSyncStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableSyncStringify(value[key])}`).join(',')}}`;
}

function canonicalSyncValue(key, value) {
  if (key === 'ap_local_storage_backup' && value && typeof value === 'object') {
    return {
      keys: Array.isArray(value.keys) ? value.keys.slice().sort() : [],
      data: value.data && typeof value.data === 'object' ? value.data : {}
    };
  }

  if (key === 'ap_audit_drafts' && Array.isArray(value)) {
    return value.map(row => {
      if (!row || typeof row !== 'object') return row;
      const draft = { ...row };
      delete draft.updatedAt;
      if (draft.session && typeof draft.session === 'object') {
        draft.session = { ...draft.session };
        delete draft.session.at;
      }
      return draft;
    });
  }

  return value;
}

function syncValuesEqual(key, a, b) {
  return stableSyncStringify(canonicalSyncValue(key, a)) === stableSyncStringify(canonicalSyncValue(key, b));
}

function isProtectedSyncPath(pathname) {
  return pathname === '/api/sync' || pathname.startsWith('/api/sync/');
}

function hasCurrentSyncClient(req) {
  return String(req.headers['x-auditpro-client'] || '') === REQUIRED_SYNC_CLIENT;
}

function throttleSyncRead(req, res) {
  const isManifest = req.query && (req.query.manifest === '1' || req.query.meta === '1');
  if (!isManifest) return false;
  const key = String((req.authUser && (req.authUser.id || req.authUser.loginId)) || req.ip || 'anonymous');
  const now = Date.now();
  const last = recentSyncReads.get(key) || 0;
  recentSyncReads.set(key, now);
  if (last && now - last < SYNC_READ_THROTTLE_MS) {
    res.setHeader('Retry-After', String(Math.ceil((SYNC_READ_THROTTLE_MS - (now - last)) / 1000)));
    res.json({ ok: true, data: {}, throttled: true });
    return true;
  }
  return false;
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

function emailSendLockKey(input) {
  return EMAIL_SEND_LOCK_PREFIX + crypto.createHash('sha256').update(String(input || '')).digest('hex');
}

function normalizeEmailLockItems(input) {
  return (Array.isArray(input) ? input : [])
    .map(item => {
      const key = String((item && item.key) || '').trim();
      const frequencyDays = Math.max(1, Math.min(365, Number((item && item.frequencyDays) || 1)));
      if (!key) return null;
      return {
        key,
        frequencyDays,
        meta: item && typeof item.meta === 'object' ? item.meta : {}
      };
    })
    .filter(Boolean)
    .slice(0, 100);
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

function cloudinaryPostMultipart(endpoint, fields) {
  const boundary = `----auditpro-${crypto.randomBytes(12).toString('hex')}`;
  const chunks = [];
  Object.entries(fields || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="${key}"\r\n\r\n`));
    chunks.push(Buffer.from(String(value)));
    chunks.push(Buffer.from('\r\n'));
  });
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(chunks);
  const url = new URL(endpoint);

  return new Promise((resolve, reject) => {
    const req = https.request({
      method: 'POST',
      hostname: url.hostname,
      path: `${url.pathname}${url.search}`,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      },
      timeout: 30000
    }, res => {
      const parts = [];
      res.on('data', chunk => parts.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        let data = {};
        try {
          data = text ? JSON.parse(text) : {};
        } catch (_err) {
          data = { raw: text };
        }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode || 502, data });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Cloudinary request timed out')));
    req.on('error', reject);
    req.end(body);
  });
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
  const type = resourceType || 'image';
  const response = await cloudinaryPostMultipart(getCloudinaryEndpoint(cfg, type, 'destroy'), {
    public_id: publicId,
    timestamp,
    api_key: cfg.apiKey,
    signature: cloudinarySignature(params, cfg.apiSecret)
  });
  const data = response.data || {};
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

function userMergeKey(user) {
  if (!user || typeof user !== 'object') return '';
  return String(user.loginId || user.email || user.id || '').trim().toLowerCase();
}

function mergeUsersForSync(existing, incoming) {
  if (!Array.isArray(incoming)) return incoming;
  if (!Array.isArray(existing) || !existing.length) return incoming;

  const byKey = new Map();
  const existingKeys = new Set();
  existing.forEach(user => {
    const key = userMergeKey(user);
    if (key) {
      existingKeys.add(key);
      byKey.set(key, user);
    }
  });

  const incomingKeys = new Set(incoming.map(userMergeKey).filter(Boolean));
  const isShrinkingPayload = incomingKeys.size < existingKeys.size
    && Array.from(existingKeys).some(key => !incomingKeys.has(key));

  incoming.forEach(user => {
    const key = userMergeKey(user);
    if (!key) return;
    if (isShrinkingPayload && byKey.has(key)) return;
    byKey.set(key, normalizeUserForStorage(user, byKey.get(key)));
  });

  return Array.from(byKey.values());
}

function findingKey(finding) {
  if (!finding || typeof finding !== 'object') return '';
  return String(finding.id || finding.ref || '').trim();
}

function findingUpdatedTime(finding) {
  if (!finding || typeof finding !== 'object') return 0;
  const raw = finding.updatedAt || finding.findingUpdatedAt || '';
  const time = raw ? Date.parse(raw) : 0;
  return Number.isFinite(time) ? time : 0;
}

function findingDeletedTime(finding) {
  if (!finding || typeof finding !== 'object') return 0;
  const raw = finding.deletedAt || '';
  const time = raw ? Date.parse(raw) : 0;
  return Number.isFinite(time) ? time : 0;
}

function isDraftFindingLeak(finding) {
  return Boolean(
    finding
    && String(finding.status || '').toLowerCase() === 'draft'
    && finding.audit
    && finding.session
  );
}

function isDeletedFinding(finding) {
  return Boolean(finding && finding.deletedAt) || isDraftFindingLeak(finding);
}

function hasReviewDecision(finding) {
  const decision = String((finding && finding.decision) || '').toLowerCase();
  return decision === 'accept' || decision === 'reject';
}

function isReviewedOrClosedFinding(finding) {
  return hasReviewDecision(finding)
    || String((finding && finding.status) || '').toLowerCase() === 'closed'
    || String((finding && finding.capaStatus) || '').toLowerCase() === 'closed';
}

function parseAuditTimestamp(value) {
  const raw = String(value || '').trim();
  if (!raw) return 0;
  const direct = Date.parse(raw);
  if (Number.isFinite(direct)) return direct;
  const match = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:,\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M|am|pm)?)?/);
  if (!match) return 0;
  let hour = Number(match[4] || 0);
  const minute = Number(match[5] || 0);
  const second = Number(match[6] || 0);
  const meridiem = String(match[7] || '').toLowerCase();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  const time = new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]), hour, minute, second).getTime();
  return Number.isFinite(time) ? time : 0;
}

function isClosureSubmissionAction(action) {
  return /(closure submitted|submitted for review|submitted closure)/i.test(String(action || ''));
}

function isReviewDecisionAction(action) {
  return /closure (accepted|rejected)/i.test(String(action || ''));
}

function isManualStatusAction(action) {
  return /status\s*(?:→|->|â†’)/i.test(String(action || ''));
}

function latestWorkflowSignal(finding, fields, actionMatch) {
  const signal = { exists: false, time: 0, index: -1 };
  if (!finding || typeof finding !== 'object') return signal;

  fields.forEach(field => {
    const time = parseAuditTimestamp(finding[field]);
    if (time && time >= signal.time) {
      signal.exists = true;
      signal.time = time;
      signal.index = -1;
    } else if (String(finding[field] || '').trim()) {
      signal.exists = true;
    }
  });

  const logs = Array.isArray(finding.activityLog) ? finding.activityLog : [];
  logs.forEach((log, index) => {
    if (!actionMatch(String((log && log.action) || ''))) return;
    const time = parseAuditTimestamp(log && log.ts);
    signal.exists = true;
    if ((time && time >= signal.time) || (!signal.time && index >= signal.index)) {
      signal.time = time || signal.time;
      signal.index = index;
    }
  });

  return signal;
}

function closureSubmissionSignal(finding) {
  const signal = latestWorkflowSignal(
    finding,
    ['closureSubmittedAt', 'closureSubmitAt', 'closureDate'],
    isClosureSubmissionAction
  );
  if (!signal.exists && finding && typeof finding === 'object') {
    signal.exists = Boolean(String(finding.closureEvidence || '').trim() || String(finding.closureSubmittedBy || '').trim());
  }
  return signal;
}

function reviewDecisionSignal(finding) {
  return latestWorkflowSignal(
    finding,
    ['decisionAt', 'reviewedAt', 'decisionDate', 'auditClosureDate', 'closedAt'],
    isReviewDecisionAction
  );
}

function statusChangeSignal(finding) {
  return latestWorkflowSignal(
    finding,
    ['statusChangedAt'],
    isManualStatusAction
  );
}

function hasClosureSubmission(finding) {
  if (!finding || typeof finding !== 'object') return false;
  if (String(finding.closureEvidence || '').trim()) return true;
  if (String(finding.closureSubmittedBy || '').trim() || String(finding.closureDate || '').trim()) return true;
  return Array.isArray(finding.activityLog) && finding.activityLog.some(log => isClosureSubmissionAction((log && log.action) || ''));
}

function hasUnreviewedClosureSubmission(finding) {
  if (!hasClosureSubmission(finding)) return false;
  if (!hasReviewDecision(finding)) return true;
  const submitted = closureSubmissionSignal(finding);
  const reviewed = reviewDecisionSignal(finding);
  if (!submitted.exists) return false;
  if (!reviewed.exists) return false;
  if (submitted.time && reviewed.time) return submitted.time > reviewed.time;
  if (submitted.index > -1 && reviewed.index > -1) return submitted.index > reviewed.index;
  return false;
}

function isPendingReviewFinding(finding) {
  const status = String((finding && finding.status) || '').toLowerCase();
  const capaStatus = String((finding && finding.capaStatus) || '').toLowerCase();
  return status === 'pending-closure' || capaStatus === 'submitted' || (status === 'delayed' && hasUnreviewedClosureSubmission(finding));
}

function submissionNewerThanReview(submitted, reviewed) {
  const submit = closureSubmissionSignal(submitted);
  const review = reviewDecisionSignal(reviewed);
  return Boolean(submit.time && review.time && submit.time > review.time);
}

function statusChangeNewerThanReview(changed, reviewed) {
  const statusChange = statusChangeSignal(changed);
  const review = reviewDecisionSignal(reviewed);
  return Boolean(statusChange.time && review.time && statusChange.time > review.time);
}

function normalizeFindingSyncState(finding) {
  if (!finding || typeof finding !== 'object') return finding;
  if (isDraftFindingLeak(finding)) return null;
  const item = { ...finding };
  let status = String(item.status || '').toLowerCase();
  let capaStatus = String(item.capaStatus || '').toLowerCase();
  const decision = String(item.decision || '').toLowerCase();
  const pendingSignal = status === 'pending-closure' || capaStatus === 'submitted';
  const unreviewedSubmission = hasUnreviewedClosureSubmission(item);

  if (pendingSignal && (decision === 'accept' || decision === 'reject')) {
    if (unreviewedSubmission) {
      item.decision = null;
      item.decisionComments = '';
      item.decisionDate = null;
      item.auditClosureDate = null;
      item.closedAt = null;
    } else {
      item.status = decision === 'accept' ? 'closed' : 'open';
      item.capaStatus = decision === 'accept' ? 'closed' : 'open';
    }
    status = String(item.status || '').toLowerCase();
    capaStatus = String(item.capaStatus || '').toLowerCase();
  }

  if ((status === 'delayed' || capaStatus === 'delayed') && unreviewedSubmission) {
    item.status = 'pending-closure';
    item.capaStatus = 'submitted';
    if (decision === 'accept' || decision === 'reject') {
      item.decision = null;
      item.decisionComments = '';
      item.decisionDate = null;
      item.auditClosureDate = null;
      item.closedAt = null;
    }
  }

  return item;
}

function workflowMeaningfulTime(finding) {
  return Math.max(
    findingUpdatedTime(finding),
    closureSubmissionSignal(finding).time || 0,
    reviewDecisionSignal(finding).time || 0
  );
}

function mergeActivityLogs(a, b) {
  const rows = []
    .concat(Array.isArray(a && a.activityLog) ? a.activityLog : [])
    .concat(Array.isArray(b && b.activityLog) ? b.activityLog : []);
  const seen = new Set();
  return rows.map((log, index) => ({
    log,
    index,
    time: parseAuditTimestamp((log && (log.ts || log.at || log.updatedAt)) || '')
  })).filter(row => {
    const log = row.log;
    if (!log || typeof log !== 'object') return false;
    const key = [log.user || '', log.action || '', log.ts || ''].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  })
    .sort((a, b) => (a.time - b.time) || (a.index - b.index))
    .slice(-200)
    .map(row => row.log);
}

function withMergedActivityLogs(selected, other) {
  if (!selected || !other) return selected;
  const logs = mergeActivityLogs(selected, other);
  return logs.length === (Array.isArray(selected.activityLog) ? selected.activityLog.length : 0)
    ? selected
    : Object.assign({}, selected, { activityLog: logs });
}

function mergeFindingWorkflowData(selected, other) {
  if (!selected || !other) return selected;
  let out = withMergedActivityLogs(selected, other);
  let changed = out !== selected;
  const hasValue = value => (Array.isArray(value) ? value.length > 0 : String(value == null ? '' : value).trim() !== '');
  const copyMissing = field => {
    if (!hasValue(out[field]) && hasValue(other[field])) {
      if (!changed) {
        out = { ...out };
        changed = true;
      }
      out[field] = Array.isArray(other[field]) ? other[field].slice() : other[field];
    }
  };

  ['closureEvidence', 'closureSubmittedBy', 'closureDate', 'closureSubmittedAt', 'closureSubmitAt'].forEach(copyMissing);
  if (isReviewedOrClosedFinding(out) && isReviewedOrClosedFinding(other) && !isPendingReviewFinding(out)) {
    ['decision', 'decisionComments', 'decisionDate', 'decisionAt', 'auditClosureDate', 'closedAt'].forEach(copyMissing);
  }
  return out;
}

function chooseFindingForSync(current, incoming) {
  current = normalizeFindingSyncState(current);
  incoming = normalizeFindingSyncState(incoming);
  if (!current) return incoming;
  if (!incoming) return current;

  if (isDeletedFinding(current) || isDeletedFinding(incoming)) {
    const currentDeleted = findingDeletedTime(current);
    const incomingDeleted = findingDeletedTime(incoming);
    if (currentDeleted || incomingDeleted) return incomingDeleted >= currentDeleted ? incoming : current;
    return isDeletedFinding(incoming) ? incoming : current;
  }

  const currentPending = isPendingReviewFinding(current);
  const incomingPending = isPendingReviewFinding(incoming);
  const currentReviewed = isReviewedOrClosedFinding(current);
  const incomingReviewed = isReviewedOrClosedFinding(incoming);
  if (currentPending || incomingPending) {
    if (currentPending && incomingReviewed) return submissionNewerThanReview(current, incoming) ? mergeFindingWorkflowData(current, incoming) : mergeFindingWorkflowData(incoming, current);
    if (incomingPending && currentReviewed) return submissionNewerThanReview(incoming, current) ? mergeFindingWorkflowData(incoming, current) : mergeFindingWorkflowData(current, incoming);
    if (currentPending && !incomingPending && !incomingReviewed) return mergeFindingWorkflowData(current, incoming);
    if (incomingPending && !currentPending && !currentReviewed) return mergeFindingWorkflowData(incoming, current);
    if (currentPending && incomingPending) {
      const currentTime = workflowMeaningfulTime(current);
      const incomingTime = workflowMeaningfulTime(incoming);
      return mergeFindingWorkflowData(incomingTime > currentTime ? incoming : current, incomingTime > currentTime ? current : incoming);
    }
  }

  if (currentReviewed && !incomingReviewed) {
    return statusChangeNewerThanReview(incoming, current)
      ? mergeFindingWorkflowData(incoming, current)
      : mergeFindingWorkflowData(current, incoming);
  }
  if (incomingReviewed && !currentReviewed) {
    return statusChangeNewerThanReview(current, incoming)
      ? mergeFindingWorkflowData(current, incoming)
      : mergeFindingWorkflowData(incoming, current);
  }

  const currentTime = findingUpdatedTime(current);
  const incomingTime = findingUpdatedTime(incoming);
  if (currentTime || incomingTime) {
    return mergeFindingWorkflowData(incomingTime >= currentTime ? incoming : current, incomingTime >= currentTime ? current : incoming);
  }

  return mergeFindingWorkflowData(incoming, current);
}

function mergeFindingsForSync(currentValue, incomingValue) {
  if (!Array.isArray(incomingValue)) return incomingValue;
  incomingValue = incomingValue.map(normalizeFindingSyncState).filter(Boolean);
  if (!Array.isArray(currentValue) || !currentValue.length) return incomingValue;
  currentValue = currentValue.map(normalizeFindingSyncState).filter(Boolean);

  const currentByKey = new Map();
  currentValue.forEach(finding => {
    const key = findingKey(finding);
    if (key) currentByKey.set(key, finding);
  });

  const seen = new Set();
  const merged = incomingValue.map(finding => {
    const key = findingKey(finding);
    if (!key) return finding;
    seen.add(key);
    return chooseFindingForSync(currentByKey.get(key), finding);
  });

  currentValue.forEach(finding => {
    const key = findingKey(finding);
    if (key && !seen.has(key)) merged.push(finding);
  });

  return merged;
}

function normalizeAuditSeverity(severity) {
  const text = String(severity || 'obs').toLowerCase().trim();
  if (text.includes('critical')) return 'critical';
  if (text.includes('major')) return 'major';
  if (text.includes('minor')) return 'minor';
  return 'obs';
}

function auditFindingCounts(findings) {
  const counts = { critical: 0, major: 0, minor: 0, obs: 0, total: 0 };
  (Array.isArray(findings) ? findings : []).forEach(finding => {
    const key = normalizeAuditSeverity(finding && (finding.sev ?? finding.severity));
    counts[key] += 1;
    counts.total += 1;
  });
  return counts;
}

function auditScoreFromCounts(counts) {
  const score = 100
    - (Number(counts.critical || 0) * 15)
    - (Number(counts.major || 0) * 10)
    - (Number(counts.minor || 0) * 5)
    - (Number(counts.obs || 0) * 2);
  return Math.min(100, Math.max(0, Math.round(score)));
}

function completedAuditKey(audit) {
  if (!audit || typeof audit !== 'object') return '';
  return String(audit.ref || audit.auditRef || audit.id || '').trim().toLowerCase();
}

function completedAuditTime(audit) {
  if (!audit || typeof audit !== 'object') return 0;
  const time = Date.parse(audit.updatedAt || audit.submittedAt || audit.date || '');
  return Number.isFinite(time) ? time : 0;
}

function completedAuditCompleteness(audit) {
  if (!audit || typeof audit !== 'object') return 0;
  let score = audit.auditScoreFrozen !== undefined ? 1 : 0;
  score += Array.isArray(audit.findingRefs) ? audit.findingRefs.length : 0;
  if (audit.auditFindingCountsFrozen && typeof audit.auditFindingCountsFrozen === 'object') {
    score += Number(audit.auditFindingCountsFrozen.total || 0);
  }
  if (audit.session && audit.session.findings) score += Object.keys(audit.session.findings).length;
  return score;
}

function isBadDerivedCompletedAudit(audit) {
  if (!audit || typeof audit !== 'object' || !audit.derivedFromFindings) return false;
  const ref = String(audit.ref || audit.auditRef || audit.id || '').trim();
  const id = String(audit.id || '');
  return /^AUTO-[A-Z0-9]+-\d{10,}$/.test(ref) || /^derived_[a-z0-9]+_findings_?$/i.test(id);
}

function chooseCompletedAudit(current, incoming) {
  if (!current) return incoming;
  if (!incoming) return current;
  const currentTime = completedAuditTime(current);
  const incomingTime = completedAuditTime(incoming);
  if (incomingTime > currentTime) return incoming;
  if (incomingTime < currentTime) return current;
  return completedAuditCompleteness(incoming) > completedAuditCompleteness(current) ? incoming : current;
}

function repairCompletedAuditScores(audits, findings) {
  const activeFindings = (Array.isArray(findings) ? findings : [])
    .map(normalizeFindingSyncState)
    .filter(finding => finding && !finding.deletedAt && !isDraftFindingLeak(finding));
  return audits.map(audit => {
    const ref = String(audit.ref || audit.auditRef || audit.id || '').trim();
    const explicitRefs = new Set((audit.findingRefs || []).map(String));
    const rows = activeFindings.filter(finding => (
      finding.dept === audit.dept
      && (
        String(finding.auditRef || finding.auditId || '') === ref
        || explicitRefs.has(String(finding.ref || ''))
      )
    ));
    if (!rows.length) return audit;
    const counts = auditFindingCounts(rows);
    return {
      ...audit,
      findingRefs: rows.map(finding => finding.ref).filter(Boolean),
      auditScoreFrozen: auditScoreFromCounts(counts),
      auditFindingCountsFrozen: counts,
      status: audit.status || 'submitted'
    };
  });
}

function mergeCompletedAuditsForSync(currentValue, incomingValue, findingsValue) {
  if (!Array.isArray(incomingValue)) return Array.isArray(currentValue) ? currentValue : [];
  const current = (Array.isArray(currentValue) ? currentValue : []).filter(audit => !isBadDerivedCompletedAudit(audit));
  const incoming = incomingValue.filter(audit => !isBadDerivedCompletedAudit(audit));
  if (!incoming.length && current.length) return repairCompletedAuditScores(current, findingsValue);
  const byKey = new Map();
  current.concat(incoming).forEach(audit => {
    const key = completedAuditKey(audit);
    if (!key) return;
    byKey.set(key, chooseCompletedAudit(byKey.get(key), audit));
  });
  return repairCompletedAuditScores(Array.from(byKey.values()), findingsValue)
    .sort((a, b) => completedAuditTime(a) - completedAuditTime(b));
}

function notificationKey(row) {
  if (!row || typeof row !== 'object') return '';
  return String(row.id || [row.type, row.title, row.body, row.ts].join('|')).trim();
}

function notificationTime(row) {
  if (!row || typeof row !== 'object') return 0;
  const raw = String(row.ts || row.at || row.updatedAt || '').trim();
  const direct = Date.parse(raw);
  if (Number.isFinite(direct)) return direct;
  const match = raw.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4}),\s+(\d{1,2}):(\d{2})\s*(am|pm)$/i);
  if (!match) return 0;
  const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  let hour = Number(match[4]);
  const meridiem = match[6].toLowerCase();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  const time = new Date(Number(match[3]), months[match[2].toLowerCase()], Number(match[1]), hour, Number(match[5])).getTime();
  return Number.isFinite(time) ? time : 0;
}

function mergeNotificationsForSync(currentValue, incomingValue) {
  if (!Array.isArray(incomingValue)) return Array.isArray(currentValue) ? currentValue : [];
  const byKey = new Map();
  []
    .concat(Array.isArray(currentValue) ? currentValue : [], incomingValue)
    .forEach(row => {
      const key = notificationKey(row);
      if (key) byKey.set(key, Object.assign({}, byKey.get(key) || {}, row));
    });
  return Array.from(byKey.values())
    .sort((a, b) => notificationTime(b) - notificationTime(a))
    .slice(0, 600);
}

function auditDraftKey(row) {
  if (!row || typeof row !== 'object') return '';
  return String(row.userKey || row.loginId || row.id || '').trim();
}

function auditDraftTime(row) {
  if (!row || typeof row !== 'object') return 0;
  const time = Date.parse(row.updatedAt || row.at || '');
  return Number.isFinite(time) ? time : 0;
}

function auditDraftCompleteness(row) {
  if (!row || typeof row !== 'object') return 0;
  let score = row.audit ? 1 : 0;
  const session = row.session && typeof row.session === 'object' ? row.session : null;
  if (session) {
    score += 1;
    score += Object.keys(session.answers || {}).length;
    score += Object.keys(session.findings || {}).length * 2;
    score += Object.keys(session.notes || {}).length;
    if (String(session.genNotes || '').trim()) score += 1;
  }
  return score;
}

function chooseAuditDraft(current, incoming) {
  if (!current) return incoming;
  const currentTime = auditDraftTime(current);
  const incomingTime = auditDraftTime(incoming);
  if (incomingTime > currentTime) return incoming;
  if (incomingTime < currentTime) return current;
  return auditDraftCompleteness(incoming) >= auditDraftCompleteness(current) ? incoming : current;
}

function mergeAuditDraftsForSync(currentValue, incomingValue) {
  if (!Array.isArray(incomingValue)) return Array.isArray(currentValue) ? currentValue : [];
  const byKey = new Map();
  []
    .concat(Array.isArray(currentValue) ? currentValue : [], incomingValue)
    .forEach(row => {
      const key = auditDraftKey(row);
      if (!key) return;
      const existing = byKey.get(key);
      byKey.set(key, chooseAuditDraft(existing, row));
    });
  return Array.from(byKey.values())
    .sort((a, b) => auditDraftTime(b) - auditDraftTime(a))
    .slice(0, 100);
}

function cleanIdentity(input) {
  return String(input || '').trim().toLowerCase();
}

function base64Url(input) {
  return Buffer.from(input).toString('base64url');
}

function signText(input) {
  return crypto.createHmac('sha256', AUTH_SECRET).update(input).digest('base64url');
}

function createAuthToken(user) {
  const payload = {
    sub: String(user.id || ''),
    loginId: String(user.loginId || ''),
    role: String(user.role || ''),
    exp: Date.now() + AUTH_TOKEN_TTL_MS
  };
  const body = base64Url(JSON.stringify(payload));
  return `${body}.${signText(body)}`;
}

function parseAuthToken(token) {
  const raw = String(token || '').trim();
  const parts = raw.split('.');
  if (parts.length !== 2) return null;
  const expected = signText(parts[0]);
  const actual = parts[1];
  if (expected.length !== actual.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual))) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch (_err) {
    return null;
  }
  if (!payload || Number(payload.exp || 0) < Date.now()) return null;
  return payload;
}

function publicUser(user) {
  if (!user || typeof user !== 'object') return user;
  const copy = { ...user };
  delete copy.password;
  delete copy.passwordHash;
  delete copy.legacyPasswords;
  delete copy.legacyPasswordHashes;
  return copy;
}

function sanitizeUsersForClient(users) {
  return Array.isArray(users) ? users.map(publicUser) : users;
}

function sanitizeSyncValueForClient(key, value) {
  if (key === 'ap_users') return sanitizeUsersForClient(value);
  if (key === 'ap_local_storage_backup' && value && typeof value === 'object') {
    const copy = { ...value };
    if (copy.data && typeof copy.data === 'object') {
      copy.data = { ...copy.data };
      if (copy.data.ap_users) copy.data.ap_users = sanitizeUsersForClient(copy.data.ap_users);
      delete copy.data.ap_rem_p;
    }
    return copy;
  }
  return value;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.pbkdf2Sync(String(password), salt, PASSWORD_HASH_ITERATIONS, 32, 'sha256').toString('base64url');
  return `pbkdf2$${PASSWORD_HASH_ITERATIONS}$${salt}$${hash}`;
}

function verifyPassword(user, password) {
  if (!user) return false;
  const plain = String(password || '');
  const hashes = [user.passwordHash].concat(Array.isArray(user.legacyPasswordHashes) ? user.legacyPasswordHashes : []);
  for (const hashValue of hashes) {
    const storedHash = String(hashValue || '');
    if (storedHash.startsWith('pbkdf2$')) {
      const parts = storedHash.split('$');
      if (parts.length !== 4) continue;
      const iterations = Number(parts[1]);
      const actual = crypto.pbkdf2Sync(plain, parts[2], iterations, 32, 'sha256').toString('base64url');
      if (actual.length === parts[3].length && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(parts[3]))) return true;
    }
  }
  const legacyPlain = Array.isArray(user.legacyPasswords) ? user.legacyPasswords : [];
  if (legacyPlain.some(value => String(value || '') === plain)) return true;
  const storedHash = String(user.passwordHash || '');
  if (storedHash.startsWith('pbkdf2$')) {
    const parts = storedHash.split('$');
    if (parts.length !== 4) return false;
    const iterations = Number(parts[1]);
    const actual = crypto.pbkdf2Sync(plain, parts[2], iterations, 32, 'sha256').toString('base64url');
    return actual.length === parts[3].length && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(parts[3]));
  }
  const storedPlain = String(user.password || '');
  return storedPlain.length === plain.length && crypto.timingSafeEqual(Buffer.from(storedPlain), Buffer.from(plain));
}

function normalizeUserForStorage(user, existing) {
  if (!user || typeof user !== 'object') return user;
  const next = { ...(existing || {}), ...user };
  const password = Object.prototype.hasOwnProperty.call(user, 'password') ? String(user.password || '') : '';
  if (password) {
    next.passwordHash = hashPassword(password);
    delete next.legacyPasswordHashes;
    delete next.legacyPasswords;
  } else if (existing && existing.passwordHash) {
    next.passwordHash = existing.passwordHash;
  } else if (existing && existing.password) {
    next.passwordHash = hashPassword(existing.password);
  }
  delete next.password;
  return next;
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
    const aliases = Array.isArray(user.legacyLoginIds) ? user.legacyLoginIds : [];
    return cleanIdentity(user.loginId) === needle
      || cleanIdentity(user.email) === needle
      || aliases.some(alias => cleanIdentity(alias) === needle);
  }) || null;
}

async function findActiveUserFromToken(req) {
  const auth = String(req.headers.authorization || '');
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : String(req.headers['x-auth-token'] || '');
  const payload = parseAuthToken(token);
  if (!payload) return null;
  const { users } = await getUsersRecord();
  return users.find(user => {
    if (!user || user.active === false) return false;
    if (String(user.id || '') === String(payload.sub || '')) return true;
    return cleanIdentity(user.loginId) === cleanIdentity(payload.loginId);
  }) || null;
}

async function requireApiAuth(req, res, next) {
  if (!req.path.startsWith('/api/')) return next();
  const publicRoute = req.path === '/api/health'
    || req.path === '/api/auth/login'
    || req.path === '/api/auth/forgot-password'
    || req.path === '/api/auth/reset-password';
  if (publicRoute) return next();
  const user = await findActiveUserFromToken(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Authentication required' });
  req.authUser = user;
  if (isProtectedSyncPath(req.path) && !hasCurrentSyncClient(req)) {
    res.setHeader('X-AuditPro-Client-Warning', 'refresh-recommended');
  }
  return next();
}

function requireAdmin(req) {
  if (!req.authUser || req.authUser.role !== 'admin') {
    const err = new Error('Master Admin access required');
    err.statusCode = 403;
    throw err;
  }
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

app.post('/api/auth/login', wrapAsync(async (req, res) => {
  const identity = cleanIdentity(req.body && req.body.identity);
  const password = String((req.body && req.body.password) || '');
  if (!identity || !password) return res.status(400).json({ ok: false, error: 'Login ID and password are required' });

  const { collection, users } = await getUsersRecord();
  const user = findUserByIdentity(users, identity);
  if (!user || !verifyPassword(user, password)) {
    return res.status(401).json({ ok: false, error: 'Invalid credentials' });
  }

  if (!user.passwordHash && user.password) {
    const nextUsers = users.map(row => row && row.id === user.id ? normalizeUserForStorage(row, row) : row);
    await collection.updateOne(
      { key: 'ap_users' },
      { $set: { key: 'ap_users', value: nextUsers, updatedAt: new Date(), updatedBy: 'password-hash-migration' } },
      { upsert: true }
    );
  }

  res.json({
    ok: true,
    token: createAuthToken(user),
    user: publicUser(user),
    expiresInMs: AUTH_TOKEN_TTL_MS
  });
}));

app.get('/api/auth/me', wrapAsync(async (req, res) => {
  const user = await findActiveUserFromToken(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Authentication required' });
  res.json({ ok: true, user: publicUser(user) });
}));

app.use(wrapAsync(requireApiAuth));

app.put('/api/auth/profile', wrapAsync(async (req, res) => {
  const patch = req.body || {};
  const name = String(patch.name || '').trim();
  const email = String(patch.email || '').trim();
  const dept = String(patch.dept || '').trim();
  const password = Object.prototype.hasOwnProperty.call(patch, 'password') ? String(patch.password || '') : '';

  if (!name) return res.status(400).json({ ok: false, error: 'Name is required' });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'Valid email is required' });
  }
  if (password && password.length < 6) {
    return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters' });
  }

  const { collection, users } = await getUsersRecord();
  const index = users.findIndex(user => user && String(user.id || '') === String(req.authUser.id || ''));
  if (index < 0) return res.status(404).json({ ok: false, error: 'Account not found' });

  const current = users[index];
  const nextUser = normalizeUserForStorage({
    ...current,
    name,
    email,
    dept,
    avatar: name.substring(0, 2).toUpperCase(),
    ...(password ? { password } : {})
  }, current);
  const nextUsers = users.slice();
  nextUsers[index] = nextUser;
  const now = new Date();

  await collection.updateOne(
    { key: 'ap_users' },
    { $set: { key: 'ap_users', value: nextUsers, updatedAt: now, updatedBy: current.loginId || 'profile-update' } },
    { upsert: true }
  );

  res.json({ ok: true, user: publicUser(nextUser), updatedAt: now });
}));

app.get('/api/sync/keys', (_req, res) => {
  res.json({ ok: true, keys: SYNC_KEYS });
});

app.get('/api/sync', wrapAsync(async (_req, res) => {
  if (throttleSyncRead(_req, res)) return;
  const collection = await getCollection();
  const rows = await collection.find({
    key: { $in: SYNC_KEYS.filter(key => key !== 'ap_local_storage_backup') }
  }).toArray();
  if (_req.query && (_req.query.manifest === '1' || _req.query.meta === '1')) {
    const data = {};
    rows.forEach(row => {
      data[row.key] = {
        updatedAt: row.updatedAt,
        updatedBy: row.updatedBy || 'system'
      };
    });
    return res.json({ ok: true, data, manifest: true });
  }
  const data = {};
  rows.forEach(row => {
    data[row.key] = {
      value: sanitizeSyncValueForClient(row.key, row.value),
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
  res.json({ ok: true, key, value: row ? sanitizeSyncValueForClient(key, row.value) : null, updatedAt: row ? row.updatedAt : null });
}));

app.put('/api/sync/:key', wrapAsync(async (req, res) => {
  const { key } = req.params;
  assertSyncKey(key);

  const collection = await getCollection();
  const now = new Date();
  let incomingValue = req.body && Object.prototype.hasOwnProperty.call(req.body, 'value') ? req.body.value : null;
  let currentRow = null;
  const loadCurrent = async () => {
    if (!currentRow) currentRow = await collection.findOne({ key });
    return currentRow;
  };
  if (key === 'ap_users' || key === 'ap_permissions') requireAdmin(req);

  if (key === 'ap_email_logs') {
    const current = await loadCurrent();
    const replace = Boolean(req.body && req.body.replace);
    const clearedAt = replace && Array.isArray(incomingValue) && incomingValue.length === 0
      ? now
      : (current && current.clearedAt);
    const value = replace
      ? (Array.isArray(incomingValue) ? incomingValue : [])
      : mergeEmailLogs(current && current.value, incomingValue, clearedAt);

    if (!replace && current && syncValuesEqual(key, current.value, value)) {
      return res.json({ ok: true, key, skipped: true, updatedAt: current.updatedAt || null, count: value.length });
    }

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

  if (key === 'ap_finds') {
    const current = await loadCurrent();
    incomingValue = mergeFindingsForSync(current && current.value, incomingValue);
  }

  if (key === 'ap_users') {
    const current = await loadCurrent();
    incomingValue = mergeUsersForSync(current && current.value, incomingValue);
  }

  if (key === 'ap_audit_drafts') {
    const current = await loadCurrent();
    incomingValue = mergeAuditDraftsForSync(current && current.value, incomingValue);
  }

  if (key === 'ap_completed_audits') {
    const [current, findingsRow] = await Promise.all([
      loadCurrent(),
      collection.findOne({ key: 'ap_finds' })
    ]);
    incomingValue = mergeCompletedAuditsForSync(current && current.value, incomingValue, findingsRow && findingsRow.value);
  }

  if (key === 'ap_notifs') {
    const current = await loadCurrent();
    incomingValue = mergeNotificationsForSync(current && current.value, incomingValue);
  }

  const current = await loadCurrent();
  if (current && syncValuesEqual(key, current.value, incomingValue)) {
    return res.json({ ok: true, key, skipped: true, updatedAt: current.updatedAt || null });
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
  if (keys.includes('ap_users') || keys.includes('ap_permissions')) requireAdmin(req);

  const collection = await getCollection();
  const now = new Date();
  const currentRows = new Map();
  const getCurrent = async key => {
    if (!currentRows.has(key)) currentRows.set(key, await collection.findOne({ key }));
    return currentRows.get(key);
  };
  for (const key of keys) {
    const current = await getCurrent(key);
    if (key === 'ap_finds') {
      items[key] = mergeFindingsForSync(current && current.value, items[key]);
    }
    if (key === 'ap_audit_drafts') {
      items[key] = mergeAuditDraftsForSync(current && current.value, items[key]);
    }
    if (key === 'ap_email_logs') {
      items[key] = mergeEmailLogs(current && current.value, items[key], current && current.clearedAt);
    }
    if (key === 'ap_users') {
      items[key] = mergeUsersForSync(current && current.value, items[key]);
    }
    if (key === 'ap_completed_audits') {
      const findingsRow = keys.includes('ap_finds')
        ? null
        : await collection.findOne({ key: 'ap_finds' });
      items[key] = mergeCompletedAuditsForSync(
        current && current.value,
        items[key],
        Array.isArray(items.ap_finds) ? items.ap_finds : (findingsRow && findingsRow.value)
      );
    }
    if (key === 'ap_notifs') {
      items[key] = mergeNotificationsForSync(current && current.value, items[key]);
    }
  }
  const writeKeys = keys.filter(key => {
    const current = currentRows.get(key);
    return !(current && syncValuesEqual(key, current.value, items[key]));
  });

  if (!writeKeys.length) {
    return res.json({ ok: true, count: 0, skipped: keys.length, updatedAt: now });
  }

  await collection.bulkWrite(writeKeys.map(key => ({
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

  res.json({ ok: true, count: writeKeys.length, skipped: keys.length - writeKeys.length, updatedAt: now });
}));

app.delete('/api/sync/:key', wrapAsync(async (req, res) => {
  requireAdmin(req);
  const { key } = req.params;
  assertSyncKey(key);
  const collection = await getCollection();
  await collection.deleteOne({ key });
  res.json({ ok: true, key });
}));

app.delete('/api/sync', wrapAsync(async (req, res) => {
  requireAdmin(req);
  const collection = await getCollection();
  const result = await collection.deleteMany({ key: { $in: SYNC_KEYS } });
  res.json({ ok: true, deletedCount: result.deletedCount });
}));

app.get('/api/email/verify', wrapAsync(async (_req, res) => {
  const transport = getMailer();
  const verified = await transport.verify();
  res.json({ ok: true, smtp: Boolean(verified), user: SMTP_USER });
}));

app.post('/api/email/locks/claim', wrapAsync(async (req, res) => {
  const locks = normalizeEmailLockItems(req.body && req.body.locks);
  if (!locks.length) return res.status(400).json({ ok: false, error: 'At least one email lock is required' });

  const collection = await getCollection();
  const now = new Date();
  const pendingUntil = new Date(now.getTime() + EMAIL_LOCK_PENDING_MS);
  const claimedBy = String((req.body && req.body.by) || 'browser').slice(0, 80);
  const results = [];

  for (const item of locks) {
    const key = emailSendLockKey(item.key);
    const nextAllowedAt = new Date(now.getTime() + item.frequencyDays * 24 * 60 * 60 * 1000);
    try {
      const doc = await collection.findOneAndUpdate(
        {
          key,
          $and: [
            { $or: [{ nextAllowedAt: { $exists: false } }, { nextAllowedAt: { $lte: now } }] },
            { $or: [{ pendingUntil: { $exists: false } }, { pendingUntil: { $lte: now } }] }
          ]
        },
        {
          $set: {
            key,
            lockKey: item.key,
            frequencyDays: item.frequencyDays,
            nextAllowedAt,
            pendingUntil,
            claimedAt: now,
            claimedBy,
            meta: item.meta
          },
          $setOnInsert: { createdAt: now }
        },
        { upsert: true, returnDocument: 'after' }
      );
      results.push({ key: item.key, granted: Boolean(doc) });
    } catch (err) {
      if (err && err.code === 11000) {
        results.push({ key: item.key, granted: false });
      } else {
        throw err;
      }
    }
  }

  res.json({ ok: true, locks: results });
}));

app.post('/api/email/locks/commit', wrapAsync(async (req, res) => {
  const locks = normalizeEmailLockItems(req.body && req.body.locks);
  if (!locks.length) return res.status(400).json({ ok: false, error: 'At least one email lock is required' });

  const collection = await getCollection();
  const now = new Date();
  const success = Boolean(req.body && req.body.success);
  const committedBy = String((req.body && req.body.by) || 'browser').slice(0, 80);
  const pendingUntil = new Date(0);
  const results = [];

  for (const item of locks) {
    const nextAllowedAt = new Date(now.getTime() + item.frequencyDays * 24 * 60 * 60 * 1000);
    const update = success
      ? {
          $set: {
            frequencyDays: item.frequencyDays,
            lastSentAt: now,
            nextAllowedAt,
            pendingUntil,
            committedAt: now,
            committedBy,
            meta: item.meta
          }
        }
      : {
          $set: {
            frequencyDays: item.frequencyDays,
            lastFailedAt: now,
            nextAllowedAt: pendingUntil,
            pendingUntil,
            committedAt: now,
            committedBy,
            meta: item.meta
          }
        };
    const result = await collection.updateOne({ key: emailSendLockKey(item.key) }, update);
    results.push({ key: item.key, updated: result.modifiedCount > 0 });
  }

  res.json({ ok: true, locks: results });
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
  const response = await cloudinaryPostMultipart(getCloudinaryEndpoint(cfg, 'auto', 'upload'), {
    file: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
    folder: params.folder,
    overwrite: params.overwrite,
    public_id: params.public_id,
    timestamp,
    api_key: cfg.apiKey,
    signature: cloudinarySignature(params, cfg.apiSecret)
  });
  const upload = response.data || {};
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
  const response = await cloudinaryPostMultipart(getCloudinaryEndpoint(cfg, 'auto', 'upload'), {
    file,
    folder,
    timestamp,
    api_key: cfg.apiKey,
    signature: cloudinarySignature(signed, cfg.apiSecret)
  });
  const upload = response.data || {};
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

  try {
    await transport.sendMail({
      from: SMTP_FROM,
      to: user.email,
      subject,
      text,
      html
    });
  } catch (err) {
    await deletePasswordResetOtp(collection, user.id);
    err.statusCode = 502;
    err.message = `Password reset email could not be sent: ${err.message}`;
    throw err;
  }

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

  const nextUsers = users.map(row => row && row.id === user.id ? normalizeUserForStorage({ ...row, password }, row) : row);
  const now = new Date();
  await collection.updateOne(
    { key: 'ap_users' },
    { $set: { key: 'ap_users', value: nextUsers, updatedAt: now, updatedBy: 'password-reset' } },
    { upsert: true }
  );
  await deletePasswordResetOtp(collection, user.id);

  res.json({ ok: true, userId: user.id, loginId: user.loginId, updatedAt: now });
}));

app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: '30d',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      return;
    }
    if (/\.(?:png|jpg|jpeg|gif|webp|ico|pdf|woff2?|ttf|css|js)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
    }
  }
}));

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
