'use strict';

require('dotenv').config();

const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || 'onepws_audit';
const PASSWORD_HASH_ITERATIONS = Number(process.env.PASSWORD_HASH_ITERATIONS || 120000);

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.pbkdf2Sync(String(password), salt, PASSWORD_HASH_ITERATIONS, 32, 'sha256').toString('base64url');
  return `pbkdf2$${PASSWORD_HASH_ITERATIONS}$${salt}$${hash}`;
}

function clean(value) {
  return String(value || '').trim();
}

function avatarFor(name) {
  return clean(name).substring(0, 2).toUpperCase() || 'US';
}

function stableId(loginId) {
  return `u_${clean(loginId).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;
}

function parseUsers() {
  const raw = process.env.AUDIT_USERS_JSON;
  if (!raw) {
    throw new Error('AUDIT_USERS_JSON is required. Pass an array of {loginId,password,name,role,dept}.');
  }
  const users = JSON.parse(raw);
  if (!Array.isArray(users) || !users.length) {
    throw new Error('AUDIT_USERS_JSON must be a non-empty array.');
  }
  return users.map((user, index) => {
    const loginId = clean(user.loginId);
    const password = String(user.password || '');
    const name = clean(user.name);
    const role = clean(user.role);
    if (!loginId || !password || !name || !role) {
      throw new Error(`User at index ${index} needs loginId, password, name, and role.`);
    }
    return {
      loginId,
      password,
      name,
      role,
      dept: clean(user.dept),
      email: clean(user.email),
      active: user.active !== false
    };
  });
}

function ensureUniqueIds(users) {
  const seen = new Set();
  return users.map(user => {
    const next = { ...user };
    const id = clean(next.id);
    if (!id || seen.has(id)) {
      next.id = stableId(next.loginId || next.email || next.name);
    }
    while (seen.has(next.id)) {
      next.id = `${next.id}_${crypto.randomBytes(2).toString('hex')}`;
    }
    seen.add(next.id);
    return next;
  });
}

async function main() {
  if (!MONGODB_URI) throw new Error('MONGODB_URI is not configured in .env');

  const incomingUsers = parseUsers();
  const client = new MongoClient(MONGODB_URI);
  await client.connect();

  const collection = client.db(MONGODB_DB).collection('appdata');
  await collection.createIndex({ key: 1 }, { unique: true });

  const currentRow = await collection.findOne({ key: 'ap_users' });
  const currentUsers = Array.isArray(currentRow && currentRow.value) ? currentRow.value : [];
  const byLogin = new Map(currentUsers.map(user => [clean(user && user.loginId).toLowerCase(), user]));

  let changed = 0;
  const nextUsers = currentUsers.slice();
  for (const incoming of incomingUsers) {
    const key = incoming.loginId.toLowerCase();
    const existing = byLogin.get(key);
    const next = {
      ...(existing || {}),
      id: clean(existing && existing.id) || stableId(incoming.loginId),
      loginId: incoming.loginId,
      name: incoming.name,
      role: incoming.role,
      dept: incoming.dept,
      email: incoming.email || clean(existing && existing.email),
      active: incoming.active,
      avatar: avatarFor(incoming.name),
      passwordHash: hashPassword(incoming.password)
    };
    delete next.password;
    delete next.legacyPasswords;
    delete next.legacyPasswordHashes;

    if (existing) {
      const index = nextUsers.findIndex(user => user === existing);
      nextUsers[index] = next;
    } else {
      nextUsers.push(next);
    }
    byLogin.set(key, next);
    changed += 1;
  }

  const uniqueUsers = ensureUniqueIds(nextUsers);
  const now = new Date();
  await collection.updateOne(
    { key: 'ap_users' },
    {
      $set: {
        key: 'ap_users',
        value: uniqueUsers,
        updatedAt: now,
        updatedBy: process.env.AUDIT_USERS_UPDATED_BY || 'user-upsert-script'
      }
    },
    { upsert: true }
  );

  await client.close();
  console.log(`Upserted ${changed} user(s) into ${MONGODB_DB}.appdata/ap_users.`);
  console.log(`Total users: ${uniqueUsers.length}. Passwords are stored as hashes only.`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
