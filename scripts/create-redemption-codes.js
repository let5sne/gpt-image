#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, '..', 'storage');
const CREDITS_FILE = process.env.CREDITS_FILE || path.join(STORAGE_DIR, 'credits.json');
const CREDIT_CODE_PEPPER = process.env.CREDIT_CODE_PEPPER || 'change-me';

function readArg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

function emptyState() {
  return {
    users: [],
    accounts: [],
    credit_ledger: [],
    redemption_batches: [],
    redemption_codes: [],
  };
}

function readState() {
  if (!fs.existsSync(CREDITS_FILE)) return emptyState();
  return { ...emptyState(), ...JSON.parse(fs.readFileSync(CREDITS_FILE, 'utf-8')) };
}

function writeState(state) {
  fs.mkdirSync(path.dirname(CREDITS_FILE), { recursive: true });
  fs.writeFileSync(CREDITS_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

function hashCode(code) {
  return crypto.createHash('sha256').update(`${CREDIT_CODE_PEPPER}:${code}`).digest('hex');
}

function makeCode(prefix) {
  const raw = crypto.randomBytes(12).toString('base64url').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return `${prefix}-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

const count = Number(readArg('count', 10));
const credits = Number(readArg('credits', 100));
const name = readArg('name', `batch-${new Date().toISOString().slice(0, 10)}`);
const prefix = readArg('prefix', 'IMG');
const expiresAt = readArg('expires-at', null);

if (!Number.isInteger(count) || count < 1 || count > 10000) {
  throw new Error('--count must be an integer between 1 and 10000');
}
if (!Number.isInteger(credits) || credits < 1) {
  throw new Error('--credits must be a positive integer');
}
if (!process.env.CREDIT_CODE_PEPPER || process.env.CREDIT_CODE_PEPPER === 'change-me') {
  throw new Error('CREDIT_CODE_PEPPER must be configured before generating codes');
}

const state = readState();
const batchId = crypto.randomUUID();
const now = new Date().toISOString();
const plainCodes = [];

state.redemption_batches.push({
  id: batchId,
  name,
  credits_per_code: credits,
  code_count: count,
  expires_at: expiresAt,
  created_at: now,
});

for (let i = 0; i < count; i += 1) {
  let code = makeCode(prefix);
  while (state.redemption_codes.some((item) => item.code_hash === hashCode(code))) {
    code = makeCode(prefix);
  }
  plainCodes.push(code);
  state.redemption_codes.push({
    id: crypto.randomUUID(),
    batch_id: batchId,
    code_hash: hashCode(code),
    credits,
    status: 'active',
    redeemed_by_user_id: null,
    redeemed_at: null,
    expires_at: expiresAt,
    created_at: now,
  });
}

writeState(state);

console.log(`batch_id,${batchId}`);
console.log('code,credits,expires_at');
for (const code of plainCodes) {
  console.log(`${code},${credits},${expiresAt || ''}`);
}
