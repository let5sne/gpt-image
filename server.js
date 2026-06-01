require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_VERCEL = Boolean(process.env.VERCEL);
const ENABLE_LOCAL_STORAGE = !IS_VERCEL;
const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, 'storage');
const IMAGE_STORAGE_PROVIDER = (process.env.IMAGE_STORAGE_PROVIDER || (ENABLE_LOCAL_STORAGE ? 'local' : 'none')).trim().toLowerCase();
const IMAGE_STORAGE_PUBLIC_BASE_URL = (process.env.IMAGE_STORAGE_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const IMAGE_STORAGE_PREFIX = (process.env.IMAGE_STORAGE_PREFIX || '').trim().replace(/^\/+|\/+$/g, '');
const IMAGE_STORAGE_UPLOAD_TIMEOUT_MS = Number(process.env.IMAGE_STORAGE_UPLOAD_TIMEOUT_MS || 30000);
const AUTH_TOKEN = process.env.APP_ACCESS_TOKEN || '';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const AUTH_REQUIRED = process.env.AUTH_REQUIRED === 'true' || IS_VERCEL;
const IMAGE_PROVIDER = (process.env.IMAGE_PROVIDER || 'openai').trim().toLowerCase();
const DATABASE_URL = (process.env.DATABASE_URL || '').trim();
const DB_DUAL_WRITE = process.env.DB_DUAL_WRITE === 'true';
// Phase 3a 读切换:仅 admin overview 的 credits 聚合改从 DB 读(默认关,可独立回滚)。
// 依赖 getDbPool()——即要求 DB_DUAL_WRITE+DATABASE_URL 已就绪,确保只读已被双写填充的库。
const DB_READ_CREDITS_OVERVIEW = process.env.DB_READ_CREDITS_OVERVIEW === 'true';
// Phase 3b 读切换:redemption 列表(batches/codes)改从 DB 读(默认关,独立回滚)。
// 复用同一份 JS 聚合逻辑,仅替换数据源,避免 SQL 重写引入静默序列化漂移。
const DB_READ_REDEMPTION_LISTS = process.env.DB_READ_REDEMPTION_LISTS === 'true';
// Phase 4 Stage D 读切换:admin api-customers 列表/用量改从 DB 读(默认关,独立回滚)。
// 仅限只读 admin 报表路径——容忍异步镜像的有界滞后;计费决策读(鉴权/预扣)绝不切。
// 复用 Stage C 已 prod 验证无损的 loadCreditsStateFromDb(),失败回退文件态。
const DB_READ_API_CUSTOMERS = process.env.DB_READ_API_CUSTOMERS === 'true';
const EMAIL_AUTH_ENABLED = process.env.EMAIL_AUTH_ENABLED === 'true';

const OPENAI_COMPATIBLE_PROVIDERS = new Set([
  'openai',
  'openai-compatible',
  'openai_compatible',
  'openrouter',
  'siliconflow',
  'together',
  'minimax',
  'doubao',
  'volcengine',
]);

function firstNonEmptyEnv(candidates) {
  for (const name of candidates) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim() !== '') {
      return {
        name,
        value: value.trim(),
      };
    }
  }
  return {
    name: candidates[0],
    value: '',
  };
}

function toEnvPrefix(provider) {
  if (typeof provider !== 'string' || provider.trim() === '') {
    return 'UNKNOWN';
  }
  const normalized = provider.replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  return normalized ? normalized.toUpperCase() : 'UNKNOWN';
}

function resolveProviderConfig(provider) {
  if (provider === 'replicate') {
    return {
      provider,
      kind: 'replicate',
      missingEnv: process.env.REPLICATE_API_TOKEN ? [] : ['REPLICATE_API_TOKEN'],
      apiBase: '',
      apiKey: '',
      apiModel: '',
      bypassSecret: '',
      resolvedFrom: {},
    };
  }

  if (!OPENAI_COMPATIBLE_PROVIDERS.has(provider)) {
    return {
      provider,
      kind: 'unsupported',
      missingEnv: ['IMAGE_PROVIDER'],
      apiBase: '',
      apiKey: '',
      apiModel: '',
      bypassSecret: '',
      resolvedFrom: {},
    };
  }

  const prefix = toEnvPrefix(provider);
  const base = firstNonEmptyEnv([`${prefix}_IMAGE_API_BASE`, 'IMAGE_API_BASE']);
  const key = firstNonEmptyEnv([`${prefix}_IMAGE_API_KEY`, 'IMAGE_API_KEY']);
  const model = firstNonEmptyEnv([`${prefix}_IMAGE_API_MODEL`, 'IMAGE_API_MODEL']);
  const bypassSecret = firstNonEmptyEnv([`${prefix}_IMAGE_API_BYPASS_SECRET`, 'IMAGE_API_BYPASS_SECRET']);
  const missingEnv = [];

  if (!base.value) missingEnv.push(`${prefix}_IMAGE_API_BASE|IMAGE_API_BASE`);
  if (!key.value) missingEnv.push(`${prefix}_IMAGE_API_KEY|IMAGE_API_KEY`);

  return {
    provider,
    kind: 'openai-compatible',
    missingEnv,
    apiBase: base.value,
    apiKey: key.value,
    apiModel: model.value || 'gpt-image-2',
    bypassSecret: bypassSecret.value,
    resolvedFrom: {
      apiBase: base.name,
      apiKey: key.name,
      apiModel: model.name,
      bypassSecret: bypassSecret.name,
    },
  };
}

function getImageStorageMissingEnv(provider) {
  if (provider === 'none' || provider === 'local') return [];
  if (provider !== 's3') return ['IMAGE_STORAGE_PROVIDER'];

  const required = [
    'IMAGE_STORAGE_PUBLIC_BASE_URL',
    'S3_ENDPOINT',
    'S3_BUCKET',
    'S3_REGION',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
  ];
  return required.filter((name) => !process.env[name] || process.env[name].trim() === '');
}

const PROVIDER_CONFIG = resolveProviderConfig(IMAGE_PROVIDER);
const missingEnv = [...PROVIDER_CONFIG.missingEnv, ...getImageStorageMissingEnv(IMAGE_STORAGE_PROVIDER)];
if (AUTH_REQUIRED && !process.env.APP_ACCESS_TOKEN) {
  missingEnv.push('APP_ACCESS_TOKEN');
}

if (IS_VERCEL && PROVIDER_CONFIG.kind === 'replicate') {
  throw new Error(
    'IMAGE_PROVIDER=replicate is not supported on Vercel: jobs are kept in process memory and will be lost between invocations. ' +
      'Use a different provider on Vercel, or move job state to KV/DB before re-enabling.'
  );
}

const ALLOWED_SIZES = new Set([
  '1024x1024',
  '1024x1536',
  '1536x1024',
]);
const MAX_PROMPT_CHARS = Number(process.env.MAX_PROMPT_CHARS || 4000);
const MAX_IMAGES_PER_REQUEST = Number(process.env.MAX_IMAGES_PER_REQUEST || 1);
const MAX_PIXEL_COUNT = Number(process.env.MAX_PIXEL_COUNT || 1572864); // covers 1024x1536 / 1536x1024
const DAILY_LIMIT_PER_CLIENT = Number(process.env.DAILY_LIMIT_PER_CLIENT || 40);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60 * 1000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 12);
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 120000);
const IMAGE_API_BYPASS_SECRET = PROVIDER_CONFIG.bypassSecret;
const IMAGE_API_BYPASS_SECRET_HASH = IMAGE_API_BYPASS_SECRET
  ? crypto.createHash('sha256').update(IMAGE_API_BYPASS_SECRET).digest('hex').slice(0, 12)
  : '';
const REPLICATE_MODEL = process.env.REPLICATE_MODEL || 'openai/gpt-image-2';
const REPLICATE_POLL_INTERVAL_MS = Number(process.env.REPLICATE_POLL_INTERVAL_MS || 2000);
const REPLICATE_MAX_POLL_MS = Number(process.env.REPLICATE_MAX_POLL_MS || 20 * 60 * 1000);
const JOB_RETENTION_MS = Number(process.env.JOB_RETENTION_MS || 15 * 60 * 1000);
const CREDITS_ENABLED = process.env.CREDITS_ENABLED === 'true';
const CREDIT_CODE_PEPPER = process.env.CREDIT_CODE_PEPPER || 'change-me';
const CREDITS_FILE = process.env.CREDITS_FILE || path.join(STORAGE_DIR, 'credits.json');
const ADMIN_AUDIT_LOG_FILE = process.env.ADMIN_AUDIT_LOG_FILE || path.join(STORAGE_DIR, 'admin-audit.log');
const EMAIL_AUTH_FILE = process.env.EMAIL_AUTH_FILE || path.join(STORAGE_DIR, 'email-auth.json');
const EMAIL_AUTH_PEPPER = process.env.EMAIL_AUTH_PEPPER || CREDIT_CODE_PEPPER;
const EMAIL_CODE_LENGTH = Number(process.env.EMAIL_CODE_LENGTH || 6);
const EMAIL_CODE_TTL_MS = Number(process.env.EMAIL_CODE_TTL_MS || 10 * 60 * 1000);
const EMAIL_CODE_RESEND_COOLDOWN_MS = Number(process.env.EMAIL_CODE_RESEND_COOLDOWN_MS || 60 * 1000);
const EMAIL_CODE_MAX_ATTEMPTS = Number(process.env.EMAIL_CODE_MAX_ATTEMPTS || 5);
const EMAIL_SESSION_TTL_MS = Number(process.env.EMAIL_SESSION_TTL_MS || 30 * 24 * 60 * 60 * 1000);
const EMAIL_CODE_DEV_MODE = process.env.EMAIL_CODE_DEV_MODE === 'true';
const EMAIL_AUTH_COOKIE_NAME = process.env.EMAIL_AUTH_COOKIE_NAME || 'ims_auth';
const EMAIL_SMTP_HOST = (process.env.EMAIL_SMTP_HOST || '').trim();
const EMAIL_SMTP_PORT = Number(process.env.EMAIL_SMTP_PORT || 587);
const EMAIL_SMTP_SECURE = process.env.EMAIL_SMTP_SECURE === 'true' || EMAIL_SMTP_PORT === 465;
const EMAIL_SMTP_USER = (process.env.EMAIL_SMTP_USER || '').trim();
const EMAIL_SMTP_PASS = process.env.EMAIL_SMTP_PASS || '';
const EMAIL_FROM = (process.env.EMAIL_FROM || '').trim();
const EMAIL_REPLY_TO = (process.env.EMAIL_REPLY_TO || '').trim();
const EMAIL_BRAND_NAME = (process.env.EMAIL_BRAND_NAME || 'Image Studio').trim();
const EMAIL_DELIVERY_CONFIGURED = Boolean(EMAIL_SMTP_HOST && EMAIL_SMTP_PORT && EMAIL_FROM);

if (CREDITS_ENABLED && (!process.env.CREDIT_CODE_PEPPER || CREDIT_CODE_PEPPER === 'change-me')) {
  throw new Error(
    'CREDIT_CODE_PEPPER must be set to a strong random value when CREDITS_ENABLED=true; default value is rejected.'
  );
}
const CREDIT_COSTS = {
  low: Number(process.env.CREDIT_COST_REPLICATE_GPT_IMAGE_2_LOW || 20),
  medium: Number(process.env.CREDIT_COST_REPLICATE_GPT_IMAGE_2_MEDIUM || 20),
  auto: Number(process.env.CREDIT_COST_REPLICATE_GPT_IMAGE_2_AUTO || 20),
  high: Number(process.env.CREDIT_COST_REPLICATE_GPT_IMAGE_2_HIGH || 20),
};
const ADMIN_GRANT_MAX_CREDITS = Number(process.env.ADMIN_GRANT_MAX_CREDITS || 10000);
const ADMIN_BATCH_MAX_CODES = Number(process.env.ADMIN_BATCH_MAX_CODES || 5000);
const ADMIN_BATCH_MAX_CREDITS_PER_CODE = Number(process.env.ADMIN_BATCH_MAX_CREDITS_PER_CODE || 100000);
const API_KEY_RATE_LIMIT_WINDOW_MS = Number(process.env.API_KEY_RATE_LIMIT_WINDOW_MS || 60 * 1000);
const API_KEY_RATE_LIMIT_MAX = Number(process.env.API_KEY_RATE_LIMIT_MAX || 5);
// 无效配置会让并发比较恒为 false,等于关闭限制 —— 解析失败时回落到默认 1。
const API_CUSTOMER_MAX_CONCURRENT_JOBS = (() => {
  const parsed = Number(process.env.API_CUSTOMER_MAX_CONCURRENT_JOBS || 1);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
})();

const dailyUsage = new Map();
const jobs = new Map();
const processStartedAt = Date.now();
let dbPool = null;
let dbUnavailableLogged = false;
let creditsDualWriteQueue = Promise.resolve();
let adminAuditDualWriteQueue = Promise.resolve();
const runtimeMetrics = {
  requests_total: 0,
  errors_total: 0,
  by_status: {},
  by_path: {},
  error_codes: {},
};
const dailyUsageGc = setInterval(() => {
  const today = new Date().toISOString().slice(0, 10);
  for (const key of dailyUsage.keys()) {
    if (!key.endsWith(`:${today}`)) {
      dailyUsage.delete(key);
    }
  }
}, 60 * 60 * 1000);
if (typeof dailyUsageGc.unref === 'function') {
  dailyUsageGc.unref();
}

// ── 本地存储目录 ────────────────────────────────────────
const META_FILE = path.join(STORAGE_DIR, 'metadata.json');
const JOBS_FILE = path.join(STORAGE_DIR, 'jobs.json');
const IMAGE_DIR = path.join(STORAGE_DIR, 'images');

if (ENABLE_LOCAL_STORAGE) {
  if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });
  if (!fs.existsSync(IMAGE_DIR)) fs.mkdirSync(IMAGE_DIR, { recursive: true });
  if (!fs.existsSync(META_FILE)) fs.writeFileSync(META_FILE, '[]', 'utf-8');
  if (!fs.existsSync(JOBS_FILE)) fs.writeFileSync(JOBS_FILE, '[]', 'utf-8');

  try {
    for (const entry of fs.readdirSync(STORAGE_DIR, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(png|jpe?g|webp)$/i.test(entry.name)) continue;
      const src = path.join(STORAGE_DIR, entry.name);
      const dst = path.join(IMAGE_DIR, entry.name);
      if (!fs.existsSync(dst)) fs.renameSync(src, dst);
    }
  } catch (e) {
    console.error('[storage migrate]', e.message);
  }
}

function readMeta() {
  if (!ENABLE_LOCAL_STORAGE) return [];
  try { return JSON.parse(fs.readFileSync(META_FILE, 'utf-8')); }
  catch { return []; }
}
function writeMeta(arr) {
  if (!ENABLE_LOCAL_STORAGE) return;
  fs.writeFileSync(META_FILE, JSON.stringify(arr, null, 2), 'utf-8');
}

function readStoredJobs() {
  if (!ENABLE_LOCAL_STORAGE) return [];
  try {
    const value = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf-8'));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function writeStoredJobs(items) {
  if (!ENABLE_LOCAL_STORAGE) return;
  const tmp = `${JOBS_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(items, null, 2), 'utf-8');
  fs.renameSync(tmp, JOBS_FILE);
}

function persistJobs() {
  if (!ENABLE_LOCAL_STORAGE) return;
  writeStoredJobs([...jobs.values()]);
}

function persistJob(job) {
  if (!job) return;
  jobs.set(job.id, job);
  persistJobs();
}

function deletePersistedJob(jobId) {
  jobs.delete(jobId);
  persistJobs();
}

function isTerminalJobStatus(status) {
  return ['succeeded', 'failed', 'canceled', 'timed_out'].includes(status);
}

function countBy(items, getKey) {
  return items.reduce((acc, item) => {
    const key = getKey(item) || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function normalizeOutputExtension(outputFormat) {
  if (outputFormat === 'jpeg') return 'jpg';
  return outputFormat || 'png';
}

function getImageContentType(ext) {
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  return 'image/png';
}

function encodeObjectKey(objectKey) {
  return objectKey.split('/').map((part) => encodeURIComponent(part)).join('/');
}

function buildImageObjectKey(filename) {
  return IMAGE_STORAGE_PREFIX ? `${IMAGE_STORAGE_PREFIX}/${filename}` : filename;
}

function buildPublicImageUrl(objectKey) {
  if (!IMAGE_STORAGE_PUBLIC_BASE_URL) {
    throw new Error('IMAGE_STORAGE_PUBLIC_BASE_URL is required for s3 provider');
  }
  return `${IMAGE_STORAGE_PUBLIC_BASE_URL}/${encodeObjectKey(objectKey)}`;
}

function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value).digest(encoding);
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function getSigningKey(secretKey, dateStamp, region) {
  const dateKey = hmac(`AWS4${secretKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, 's3');
  return hmac(serviceKey, 'aws4_request');
}

function buildS3UploadUrl(objectKey) {
  const endpoint = (process.env.S3_ENDPOINT || '').replace(/\/+$/, '');
  const bucket = process.env.S3_BUCKET;
  const forcePathStyle = process.env.S3_FORCE_PATH_STYLE !== 'false';
  const encodedKey = encodeObjectKey(objectKey);

  if (forcePathStyle) {
    return new URL(`${endpoint}/${encodeURIComponent(bucket)}/${encodedKey}`);
  }

  const endpointUrl = new URL(endpoint);
  endpointUrl.hostname = `${bucket}.${endpointUrl.hostname}`;
  endpointUrl.pathname = `/${encodedKey}`;
  return endpointUrl;
}

function createS3Headers({ method, url, body, contentType }) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const region = process.env.S3_REGION || 'auto';
  const accessKey = process.env.S3_ACCESS_KEY_ID;
  const secretKey = process.env.S3_SECRET_ACCESS_KEY;
  const payloadHash = sha256Hex(body);
  const headers = {
    'Content-Type': contentType,
    Host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  const canonicalHeaderEntries = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), String(value).trim()])
    .sort(([left], [right]) => left.localeCompare(right));
  const canonicalHeaders = canonicalHeaderEntries
    .map(([name, value]) => `${name}:${value}\n`)
    .join('');
  const signedHeaders = canonicalHeaderEntries.map(([name]) => name).join(';');
  const canonicalRequest = [
    method,
    url.pathname,
    url.searchParams.toString(),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');
  const signature = hmac(getSigningKey(secretKey, dateStamp, region), stringToSign, 'hex');

  headers.Authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

async function storeImageBuffer(buffer, filename, contentType) {
  if (IMAGE_STORAGE_PROVIDER === 'local') {
    const localPath = path.join(IMAGE_DIR, filename);
    const localUrl = `/storage/${filename}`;
    fs.writeFileSync(localPath, buffer);
    return { url: localUrl, localUrl };
  }

  if (IMAGE_STORAGE_PROVIDER === 's3') {
    const objectKey = buildImageObjectKey(filename);
    const uploadUrl = buildS3UploadUrl(objectKey);
    const method = 'PUT';
    const headers = createS3Headers({ method, url: uploadUrl, body: buffer, contentType });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), IMAGE_STORAGE_UPLOAD_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(uploadUrl, { method, headers, body: buffer, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      const body = await response.text();
      log('error', 's3_upload_failed', {
        status: response.status,
        body_hash: sha256Hex(body).slice(0, 12),
      });
      throw new Error(`s3 upload failed with status ${response.status}`);
    }
    return { url: buildPublicImageUrl(objectKey), localUrl: null };
  }

  return { url: null, localUrl: null };
}

async function persistGeneratedImageBuffer(buffer, context, sourceUrl = null) {
  const id = crypto.randomUUID();
  const ext = normalizeOutputExtension(context.outputFormat);
  const filename = `${id}.${ext}`;
  const contentType = getImageContentType(ext);
  const stored = await storeImageBuffer(buffer, filename, contentType);

  return {
    id,
    url: stored.url || sourceUrl,
    localUrl: stored.localUrl,
    sourceUrl,
  };
}

async function downloadImageBuffer(remoteUrl, headers = {}) {
  const imgRes = await fetch(remoteUrl, { headers });
  if (!imgRes.ok) throw new Error(`download ${imgRes.status}`);
  const arrayBuf = await imgRes.arrayBuffer();
  return Buffer.from(arrayBuf);
}

function emptyCreditsState() {
  return {
    users: [],
    accounts: [],
    credit_ledger: [],
    redemption_batches: [],
    redemption_codes: [],
    api_customers: [],
    api_keys: [],
  };
}

function emptyEmailAuthState() {
  return {
    users: [],
    verification_codes: [],
    sessions: [],
  };
}

function ensureCreditsFile() {
  if (!CREDITS_ENABLED) return;
  fs.mkdirSync(path.dirname(CREDITS_FILE), { recursive: true });
  if (!fs.existsSync(CREDITS_FILE)) {
    fs.writeFileSync(CREDITS_FILE, JSON.stringify(emptyCreditsState(), null, 2), 'utf-8');
  }
}

function readCreditsState() {
  if (!CREDITS_ENABLED) return emptyCreditsState();
  ensureCreditsFile();
  try {
    return { ...emptyCreditsState(), ...JSON.parse(fs.readFileSync(CREDITS_FILE, 'utf-8')) };
  } catch {
    return emptyCreditsState();
  }
}

function writeCreditsState(state) {
  if (!CREDITS_ENABLED) return;
  fs.mkdirSync(path.dirname(CREDITS_FILE), { recursive: true });
  const tmp = `${CREDITS_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
  fs.renameSync(tmp, CREDITS_FILE);
  enqueueCreditsSnapshotDualWrite(state, 'credits_state_write');
}

if (CREDITS_ENABLED) {
  ensureCreditsFile();
}

let inMemoryEmailAuthState = emptyEmailAuthState();

function ensureEmailAuthFile() {
  if (!EMAIL_AUTH_ENABLED || !ENABLE_LOCAL_STORAGE) return;
  fs.mkdirSync(path.dirname(EMAIL_AUTH_FILE), { recursive: true });
  if (!fs.existsSync(EMAIL_AUTH_FILE)) {
    fs.writeFileSync(EMAIL_AUTH_FILE, JSON.stringify(emptyEmailAuthState(), null, 2), 'utf-8');
  }
}

function readEmailAuthState() {
  if (!EMAIL_AUTH_ENABLED) return emptyEmailAuthState();
  if (!ENABLE_LOCAL_STORAGE) {
    return JSON.parse(JSON.stringify(inMemoryEmailAuthState));
  }

  ensureEmailAuthFile();
  try {
    return { ...emptyEmailAuthState(), ...JSON.parse(fs.readFileSync(EMAIL_AUTH_FILE, 'utf-8')) };
  } catch {
    return emptyEmailAuthState();
  }
}

function writeEmailAuthState(state) {
  if (!EMAIL_AUTH_ENABLED) return;
  if (!ENABLE_LOCAL_STORAGE) {
    inMemoryEmailAuthState = JSON.parse(JSON.stringify(state));
    return;
  }

  fs.mkdirSync(path.dirname(EMAIL_AUTH_FILE), { recursive: true });
  const tmp = `${EMAIL_AUTH_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
  fs.renameSync(tmp, EMAIL_AUTH_FILE);
}

if (EMAIL_AUTH_ENABLED) {
  ensureEmailAuthFile();
}

let creditsMutex = Promise.resolve();
function withCreditsLock(fn) {
  const next = creditsMutex.then(() => fn());
  creditsMutex = next.catch(() => {});
  return next;
}

let emailAuthMutex = Promise.resolve();
function withEmailAuthLock(fn) {
  const next = emailAuthMutex.then(() => fn());
  emailAuthMutex = next.catch(() => {});
  return next;
}

const creditsRepository = {
  readState: () => readCreditsState(),
  writeState: (state) => writeCreditsState(state),
  withLock: (fn) => withCreditsLock(fn),
};

async function safeReleaseCredits(reservation, note, requestId) {
  if (!reservation || !CREDITS_ENABLED) return null;
  try {
    return await releaseCredits(reservation, note);
  } catch (err) {
    log('error', 'credits_release_failed', {
      request_id: requestId || null,
      reservation_id: reservation.id,
      note,
      message: err.message,
    });
    return null;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function log(level, message, meta = {}) {
  console.log(
    JSON.stringify({
      ts: nowIso(),
      level,
      message,
      ...meta,
    })
  );
}

function toIsoOrNull(value) {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

// pg 把 timestamptz 解析为 JS Date(毫秒精度)。直接 .toISOString() 与文件存的
// ISO 串逐字节一致;切勿走 toIsoOrNull(它对 Date 会先字符串化,丢掉毫秒 → 静默漂移)。
function dbValueToIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function toJson(value) {
  return JSON.stringify(value && typeof value === 'object' ? value : {});
}

// Postgres `uuid` columns reject non-UUID strings, which would abort the whole
// dual-write snapshot transaction. ledger.job_id is usually a reservation UUID,
// but a Replicate prediction id is not guaranteed to be UUID-shaped — guard it
// so a single odd value degrades to NULL instead of dropping the entire snapshot.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function asUuidOrNull(value) {
  return typeof value === 'string' && UUID_RE.test(value) ? value : null;
}

function getDbPool() {
  if (!DB_DUAL_WRITE || !DATABASE_URL) return null;
  if (dbPool) return dbPool;
  try {
    // Optional dependency for M2 scaffold. If absent, primary file path still works.
    // eslint-disable-next-line global-require
    const { Pool } = require('pg');
    dbPool = new Pool({
      connectionString: DATABASE_URL,
      max: Number(process.env.DB_POOL_MAX || 4),
    });
    return dbPool;
  } catch (err) {
    if (!dbUnavailableLogged) {
      dbUnavailableLogged = true;
      log('error', 'db_dual_write_unavailable', { message: err.message });
    }
    return null;
  }
}

async function dualWriteCreditsSnapshot(state, reason) {
  const pool = getDbPool();
  if (!pool) return;
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('delete from credit_ledger');
    await client.query('delete from redemption_codes');
    await client.query('delete from api_keys');
    await client.query('delete from api_customers');
    await client.query('delete from wallets');
    await client.query('delete from users');
    await client.query('delete from redemption_batches');

    for (const user of state.users || []) {
      await client.query(
        'insert into users(id, user_token_hash, api_customer_id, status, created_at, updated_at) values ($1,$2,$3,$4,$5,$6)',
        [user.id, user.user_token_hash, asUuidOrNull(user.api_customer_id), user.status || 'active', toIsoOrNull(user.created_at) || nowIso(), toIsoOrNull(user.updated_at) || nowIso()]
      );
    }

    for (const account of state.accounts || []) {
      await client.query(
        'insert into wallets(id, user_id, available_credits, reserved_credits, created_at, updated_at) values ($1,$2,$3,$4,$5,$6)',
        [account.id, account.user_id, account.available_credits || 0, account.reserved_credits || 0, toIsoOrNull(account.created_at) || nowIso(), toIsoOrNull(account.updated_at) || nowIso()]
      );
    }

    for (const customer of state.api_customers || []) {
      await client.query(
        'insert into api_customers(id, name, contact, status, note, user_id, created_at, updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8)',
        [customer.id, customer.name, customer.contact || null, customer.status || 'active', customer.note || null, customer.user_id, toIsoOrNull(customer.created_at) || nowIso(), toIsoOrNull(customer.updated_at) || nowIso()]
      );
    }

    for (const key of state.api_keys || []) {
      await client.query(
        'insert into api_keys(id, customer_id, key_hash, key_prefix, status, expires_at, note, last_used_at, revoked_at, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [key.id, key.customer_id, key.key_hash, key.key_prefix || null, key.status || 'active', toIsoOrNull(key.expires_at), key.note || null, toIsoOrNull(key.last_used_at), toIsoOrNull(key.revoked_at), toIsoOrNull(key.created_at) || nowIso()]
      );
    }

    for (const batch of state.redemption_batches || []) {
      await client.query(
        'insert into redemption_batches(id, name, credits_per_code, code_count, expires_at, created_at) values ($1,$2,$3,$4,$5,$6)',
        [batch.id, batch.name, batch.credits_per_code || 0, batch.code_count || 0, toIsoOrNull(batch.expires_at), toIsoOrNull(batch.created_at) || nowIso()]
      );
    }

    for (const code of state.redemption_codes || []) {
      await client.query(
        'insert into redemption_codes(id, batch_id, code_hash, code_hint, credits, status, redeemed_by_user_id, redeemed_at, revoked_at, revoked_note, expires_at, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
        [
          code.id,
          code.batch_id,
          code.code_hash,
          code.code_hint || null,
          code.credits || 0,
          code.status || 'active',
          code.redeemed_by_user_id || null,
          toIsoOrNull(code.redeemed_at),
          toIsoOrNull(code.revoked_at),
          code.revoked_note || null,
          toIsoOrNull(code.expires_at),
          toIsoOrNull(code.created_at) || nowIso(),
        ]
      );
    }

    for (const ledger of state.credit_ledger || []) {
      await client.query(
        'insert into credit_ledger(id, user_id, type, credits_delta, available_after, reserved_after, reservation_id, redemption_code_id, job_id, note, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [
          ledger.id,
          ledger.user_id,
          ledger.type,
          ledger.credits_delta || 0,
          ledger.available_after || 0,
          ledger.reserved_after || 0,
          asUuidOrNull(ledger.job_id),
          asUuidOrNull(ledger.redemption_code_id),
          ledger.job_id || null,
          ledger.note || null,
          toIsoOrNull(ledger.created_at) || nowIso(),
        ]
      );
    }

    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => {});
    log('error', 'db_dual_write_snapshot_failed', {
      reason,
      message: err.message,
    });
  } finally {
    client.release();
  }
}

function enqueueCreditsSnapshotDualWrite(state, reason) {
  if (!DB_DUAL_WRITE || !DATABASE_URL) return;
  const snapshot = JSON.parse(JSON.stringify(state));
  creditsDualWriteQueue = creditsDualWriteQueue
    .then(() => dualWriteCreditsSnapshot(snapshot, reason))
    .catch(() => {});
}

async function dualWriteAdminAudit(entry) {
  const pool = getDbPool();
  if (!pool) return;
  try {
    await pool.query(
      'insert into admin_audit_logs(ts, action, request_id, detail) values ($1,$2,$3,$4::jsonb)',
      [toIsoOrNull(entry.ts) || nowIso(), entry.action, entry.request_id || null, toJson(entry.detail)]
    );
  } catch (err) {
    log('error', 'db_dual_write_admin_audit_failed', {
      action: entry.action,
      message: err.message,
    });
  }
}

function enqueueAdminAuditDualWrite(entry) {
  if (!DB_DUAL_WRITE || !DATABASE_URL) return;
  adminAuditDualWriteQueue = adminAuditDualWriteQueue
    .then(() => dualWriteAdminAudit(entry))
    .catch(() => {});
}

function sendOk(res, req, data, status = 200) {
  return res.status(status).json({
    success: true,
    data,
    request_id: req.requestId,
  });
}

function sendError(res, req, status, code, message, details) {
  runtimeMetrics.errors_total += 1;
  runtimeMetrics.error_codes[code] = (runtimeMetrics.error_codes[code] || 0) + 1;
  return res.status(status).json({
    success: false,
    error: {
      code,
      message,
      details: details || null,
    },
    request_id: req.requestId,
  });
}

function appendAdminAudit(action, req, detail = {}) {
  const entry = {
    ts: nowIso(),
    action,
    request_id: req.requestId,
    detail,
  };
  enqueueAdminAuditDualWrite(entry);
  if (!ENABLE_LOCAL_STORAGE) return;
  try {
    fs.mkdirSync(path.dirname(ADMIN_AUDIT_LOG_FILE), { recursive: true });
    const line = JSON.stringify(entry);
    fs.appendFileSync(ADMIN_AUDIT_LOG_FILE, `${line}\n`, 'utf-8');
  } catch (err) {
    log('error', 'admin_audit_log_failed', {
      request_id: req.requestId,
      action,
      message: err.message,
    });
  }
}

function readAdminAuditEntries(limit = 20, action = '') {
  if (!ENABLE_LOCAL_STORAGE) {
    return {
      total: 0,
      entries: [],
    };
  }

  try {
    if (!fs.existsSync(ADMIN_AUDIT_LOG_FILE)) {
      return {
        total: 0,
        entries: [],
      };
    }

    const lines = fs.readFileSync(ADMIN_AUDIT_LOG_FILE, 'utf-8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    const entries = lines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .filter((entry) => !action || String(entry.action || '') === action)
      .sort((left, right) => (toTimeOrZero(right.ts) - toTimeOrZero(left.ts)));

    return {
      total: entries.length,
      entries: entries.slice(0, limit),
    };
  } catch (err) {
    log('error', 'admin_audit_read_failed', {
      message: err.message,
    });
    return {
      total: 0,
      entries: [],
    };
  }
}

function parsePixels(size) {
  if (!size || size === 'auto') return 0;
  const parts = size.split('x').map(Number);
  if (parts.length !== 2 || parts.some((v) => Number.isNaN(v))) return -1;
  return parts[0] * parts[1];
}

function hashSecret(value) {
  return crypto.createHash('sha256').update(`${CREDIT_CODE_PEPPER}:${value}`).digest('hex');
}

function hashEmailAuthSecret(value) {
  return crypto.createHash('sha256').update(`${EMAIL_AUTH_PEPPER}:${value}`).digest('hex');
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function generateEmailCode() {
  const max = 10 ** EMAIL_CODE_LENGTH;
  const value = crypto.randomInt(0, max);
  return String(value).padStart(EMAIL_CODE_LENGTH, '0');
}

function createEmailTransporter() {
  const config = {
    host: EMAIL_SMTP_HOST,
    port: EMAIL_SMTP_PORT,
    secure: EMAIL_SMTP_SECURE,
  };
  if (EMAIL_SMTP_USER || EMAIL_SMTP_PASS) {
    config.auth = {
      user: EMAIL_SMTP_USER,
      pass: EMAIL_SMTP_PASS,
    };
  }
  return nodemailer.createTransport(config);
}

async function sendEmailVerificationCode(email, code) {
  if (!EMAIL_DELIVERY_CONFIGURED) {
    const error = new Error('email delivery is not configured');
    error.code = 'email_delivery_not_configured';
    throw error;
  }

  const transporter = createEmailTransporter();
  const minutes = Math.max(1, Math.floor(EMAIL_CODE_TTL_MS / 60000));
  const subject = `${EMAIL_BRAND_NAME} 登录验证码`;
  const text = [
    `${EMAIL_BRAND_NAME} 登录验证码：${code}`,
    '',
    `验证码 ${minutes} 分钟内有效。`,
    '如果不是你本人操作，请忽略这封邮件。',
  ].join('\n');
  const html = [
    `<p>${EMAIL_BRAND_NAME} 登录验证码：</p>`,
    `<p style="font-size:24px;font-weight:700;letter-spacing:4px;">${code}</p>`,
    `<p>验证码 ${minutes} 分钟内有效。</p>`,
    '<p>如果不是你本人操作，请忽略这封邮件。</p>',
  ].join('');

  await transporter.sendMail({
    from: EMAIL_FROM,
    to: email,
    replyTo: EMAIL_REPLY_TO || undefined,
    subject,
    text,
    html,
  });
}

function parseCookies(req) {
  const raw = req.headers.cookie;
  if (!raw || typeof raw !== 'string') return {};
  return raw.split(';').reduce((acc, item) => {
    const idx = item.indexOf('=');
    if (idx < 0) return acc;
    const key = item.slice(0, idx).trim();
    const value = decodeURIComponent(item.slice(idx + 1).trim());
    acc[key] = value;
    return acc;
  }, {});
}

function readEmailAuthToken(req) {
  const headerToken = req.headers['x-auth-token'];
  if (headerToken && typeof headerToken === 'string') return headerToken.trim();

  const authHeader = req.headers.authorization;
  if (authHeader && typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }

  const cookies = parseCookies(req);
  const cookieToken = cookies[EMAIL_AUTH_COOKIE_NAME];
  return cookieToken ? cookieToken.trim() : '';
}

function setEmailAuthCookie(res, token) {
  const maxAgeSeconds = Math.floor(EMAIL_SESSION_TTL_MS / 1000);
  const cookie = `${EMAIL_AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${IS_VERCEL ? '; Secure' : ''}`;
  res.setHeader('Set-Cookie', cookie);
}

function clearEmailAuthCookie(res) {
  const cookie = `${EMAIL_AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${IS_VERCEL ? '; Secure' : ''}`;
  res.setHeader('Set-Cookie', cookie);
}

function createPublicToken() {
  return `usr_${crypto.randomBytes(24).toString('base64url')}`;
}

function makeRedemptionCode(prefix = 'IMG') {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let raw = '';
  for (let i = 0; i < 12; i += 1) {
    raw += chars[crypto.randomInt(0, chars.length)];
  }
  return `${prefix}-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

function redactRedemptionCodePreview(codeHint = '') {
  if (!codeHint) return 'hidden';
  if (codeHint.length <= 6) return `${codeHint.slice(0, 2)}***`;
  return `${codeHint.slice(0, 6)}***`;
}

function serializeAdminRedemptionCode(item) {
  return {
    id: item.id,
    batch_id: item.batch_id,
    credits: item.credits,
    status: item.status,
    code_preview: redactRedemptionCodePreview(item.code_hint || ''),
    redeemed_by_user_id: item.redeemed_by_user_id || null,
    redeemed_at: item.redeemed_at || null,
    revoked_at: item.revoked_at || null,
    expires_at: item.expires_at || null,
    created_at: item.created_at,
  };
}

function findEmailUserByEmail(state, email) {
  return (state.users || []).find((user) => user.email === email) || null;
}

function serializeEmailUser(user) {
  return {
    id: user.id,
    email: user.email,
    status: user.status || 'active',
    email_verified_at: user.email_verified_at || null,
    last_login_at: user.last_login_at || null,
  };
}

function toTimeOrZero(value) {
  if (!value) return 0;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function cleanupEmailAuthState(state) {
  const now = Date.now();
  state.verification_codes = (state.verification_codes || []).filter((item) => {
    if (item.used_at) return false;
    if (!item.expires_at) return false;
    return Date.parse(item.expires_at) > now;
  });
  state.sessions = (state.sessions || []).filter((item) => {
    if (!item.expires_at) return false;
    return Date.parse(item.expires_at) > now;
  });
}

function getEmailAuthSession(state, token) {
  if (!token) return null;
  const tokenHash = hashEmailAuthSecret(token);
  const now = Date.now();
  const session = (state.sessions || []).find((item) => item.token_hash === tokenHash) || null;
  if (!session) return null;
  if (!session.expires_at || Date.parse(session.expires_at) <= now) return null;
  const user = (state.users || []).find((item) => item.id === session.user_id) || null;
  if (!user) return null;
  return { session, user };
}

function getEmailAuthUserFromRequest(req) {
  if (!EMAIL_AUTH_ENABLED) return null;
  const token = readEmailAuthToken(req);
  if (!token) return null;
  const state = readEmailAuthState();
  const auth = getEmailAuthSession(state, token);
  return auth ? auth.user : null;
}

function getUserToken(req) {
  const headerToken = req.headers['x-user-token'];
  if (headerToken && typeof headerToken === 'string') return headerToken.trim();
  const bodyToken = req.body && typeof req.body.user_token === 'string' ? req.body.user_token.trim() : '';
  return bodyToken;
}

function findUserByToken(state, token) {
  if (!token) return null;
  const tokenHash = hashSecret(token);
  return state.users.find((user) => user.user_token_hash === tokenHash) || null;
}

function getAccount(state, userId) {
  return state.accounts.find((account) => account.user_id === userId) || null;
}

function serializeWallet(state, userId) {
  const account = getAccount(state, userId);
  const recentLedger = state.credit_ledger
    .filter((entry) => entry.user_id === userId)
    .slice(-20)
    .reverse();
  return {
    available_credits: account ? account.available_credits : 0,
    reserved_credits: account ? account.reserved_credits : 0,
    recent_ledger: recentLedger,
  };
}

function summarizeWalletByEmailUserId(creditState, emailUserId) {
  const linkedUsers = (creditState.users || []).filter((item) => item.email_user_id === emailUserId);
  if (!linkedUsers.length) {
    return {
      linked: false,
      wallet_count: 0,
      available_credits: 0,
      reserved_credits: 0,
    };
  }

  const linkedUserIds = new Set(linkedUsers.map((item) => item.id));
  const accounts = (creditState.accounts || []).filter((item) => linkedUserIds.has(item.user_id));
  return {
    linked: true,
    wallet_count: accounts.length,
    available_credits: accounts.reduce((sum, account) => sum + (account.available_credits || 0), 0),
    reserved_credits: accounts.reduce((sum, account) => sum + (account.reserved_credits || 0), 0),
  };
}

function appendLedger(state, userId, type, creditsDelta, account, extra = {}) {
  state.credit_ledger.push({
    id: crypto.randomUUID(),
    user_id: userId,
    type,
    credits_delta: creditsDelta,
    available_after: account.available_credits,
    reserved_after: account.reserved_credits,
    job_id: extra.jobId || null,
    redemption_code_id: extra.redemptionCodeId || null,
    note: extra.note || null,
    created_at: new Date().toISOString(),
  });
}

function getCreditCost(quality, n) {
  const normalizedQuality = ['low', 'medium', 'auto', 'high'].includes(quality) ? quality : 'auto';
  return {
    quality: normalizedQuality,
    credits: CREDIT_COSTS[normalizedQuality] * n,
  };
}

function reserveCreditsForUserId(userId, quality, n) {
  if (!CREDITS_ENABLED) return null;
  return creditsRepository.withLock(() => {
    const state = creditsRepository.readState();
    const account = getAccount(state, userId);
    if (!account) {
      return { error: 'wallet_required' };
    }

    const cost = getCreditCost(quality, n);
    if (account.available_credits < cost.credits) {
      return {
        error: 'insufficient_credits',
        required_credits: cost.credits,
        available_credits: account.available_credits,
      };
    }

    const reservationId = crypto.randomUUID();
    account.available_credits -= cost.credits;
    account.reserved_credits += cost.credits;
    appendLedger(state, userId, 'reserve', -cost.credits, account, {
      jobId: reservationId,
      note: `quality=${cost.quality}`,
    });
    creditsRepository.writeState(state);

    return {
      id: reservationId,
      userId,
      quality: cost.quality,
      credits: cost.credits,
    };
  });
}

function reserveCreditsForRequest(req, res, quality, n) {
  if (!CREDITS_ENABLED) return null;
  const state = creditsRepository.readState();
  const user = findUserByToken(state, getUserToken(req));
  if (!user) {
    sendError(res, req, 401, 'wallet_required', 'redeem a code before generating images');
    return false;
  }

  return reserveCreditsForUserId(user.id, quality, n).then((reservation) => {
    if (reservation && reservation.error === 'wallet_required') {
      sendError(res, req, 401, 'wallet_required', 'wallet not found');
      return false;
    }
    if (reservation && reservation.error === 'insufficient_credits') {
      sendError(res, req, 402, 'insufficient_credits', 'not enough credits', {
        required_credits: reservation.required_credits,
        available_credits: reservation.available_credits,
      });
      return false;
    }
    return reservation;
  });
}

function settleCredits(reservation) {
  if (!reservation || !CREDITS_ENABLED) return Promise.resolve(null);
  return creditsRepository.withLock(() => {
    const state = creditsRepository.readState();
    const account = getAccount(state, reservation.userId);
    if (!account) return null;
    account.reserved_credits = Math.max(0, account.reserved_credits - reservation.credits);
    appendLedger(state, reservation.userId, 'settle', -reservation.credits, account, {
      jobId: reservation.id,
      note: `quality=${reservation.quality}`,
    });
    creditsRepository.writeState(state);
    return serializeWallet(state, reservation.userId);
  });
}

function releaseCredits(reservation, note = 'generation failed') {
  if (!reservation || !CREDITS_ENABLED) return Promise.resolve(null);
  return creditsRepository.withLock(() => {
    const state = creditsRepository.readState();
    const account = getAccount(state, reservation.userId);
    if (!account) return null;
    account.reserved_credits = Math.max(0, account.reserved_credits - reservation.credits);
    account.available_credits += reservation.credits;
    appendLedger(state, reservation.userId, 'release', reservation.credits, account, {
      jobId: reservation.id,
      note,
    });
    creditsRepository.writeState(state);
    return serializeWallet(state, reservation.userId);
  });
}

function grantCreditsToUserToken(userToken, credits, note) {
  return creditsRepository.withLock(() => {
    const state = creditsRepository.readState();
    const user = findUserByToken(state, userToken);
    if (!user) return null;
    const account = getAccount(state, user.id);
    if (!account) return null;

    account.available_credits += credits;
    account.updated_at = new Date().toISOString();
    appendLedger(state, user.id, 'admin_grant', credits, account, { note });
    creditsRepository.writeState(state);

    return serializeWallet(state, user.id);
  });
}

function grantCreditsToUserId(userId, credits, note) {
  return creditsRepository.withLock(() => {
    const state = creditsRepository.readState();
    const account = getAccount(state, userId);
    if (!account) return null;

    account.available_credits += credits;
    account.updated_at = new Date().toISOString();
    appendLedger(state, userId, 'admin_grant', credits, account, { note });
    creditsRepository.writeState(state);

    return serializeWallet(state, userId);
  });
}

function createApiSecret() {
  return `gim_${crypto.randomBytes(32).toString('base64url')}`;
}

// 按客户(user)聚合 credit_ledger,产出用量统计。纯只读,不改账本。
// settle 是真实扣费(负 delta),reserve/release 只是冻结/解冻,不计入消耗。
function summarizeCustomerUsage(state, userId, { now = Date.now(), days = 30, recentLimit = 15 } = {}) {
  const entries = (state.credit_ledger || []).filter((entry) => entry.user_id === userId);

  const DAY_MS = 24 * 60 * 60 * 1000;
  const window7 = now - 7 * DAY_MS;
  const window30 = now - 30 * DAY_MS;

  let totalSpent = 0;
  let totalGranted = 0;
  let generationCount = 0;
  let spent7d = 0;
  let spent30d = 0;

  // daily_30d:按本地日期补零,索引 0 = (days-1) 天前,末位 = 今天。
  const dayKeys = [];
  const dayIndex = new Map();
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(now - i * DAY_MS);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    dayIndex.set(key, dayKeys.length);
    dayKeys.push({ date: key, spent: 0 });
  }

  for (const entry of entries) {
    const ts = Date.parse(entry.created_at);
    const delta = Number(entry.credits_delta) || 0;
    if (entry.type === 'settle') {
      const spent = Math.abs(delta);
      totalSpent += spent;
      generationCount += 1;
      if (!Number.isNaN(ts)) {
        if (ts >= window7) spent7d += spent;
        if (ts >= window30) spent30d += spent;
        const d = new Date(ts);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        if (dayIndex.has(key)) dayKeys[dayIndex.get(key)].spent += spent;
      }
    } else if (entry.type === 'admin_grant' || entry.type === 'redeem') {
      totalGranted += delta;
    }
  }

  const recent = entries
    .slice(-recentLimit)
    .reverse()
    .map((entry) => ({
      type: entry.type,
      credits_delta: entry.credits_delta,
      available_after: entry.available_after,
      reserved_after: entry.reserved_after,
      job_id: entry.job_id || null,
      note: entry.note || null,
      created_at: entry.created_at,
    }));

  return {
    total_spent: totalSpent,
    total_granted: totalGranted,
    generation_count: generationCount,
    spent_7d: spent7d,
    spent_30d: spent30d,
    daily_30d: dayKeys,
    recent,
  };
}

function serializeApiCustomer(state, customer) {
  const account = customer ? getAccount(state, customer.user_id) : null;
  const keys = (state.api_keys || []).filter((item) => item.customer_id === customer.id);
  const usage = summarizeCustomerUsage(state, customer.user_id);
  return {
    id: customer.id,
    name: customer.name,
    contact: customer.contact || '',
    status: customer.status || 'active',
    note: customer.note || '',
    user_id: customer.user_id,
    wallet: {
      available_credits: account ? account.available_credits : 0,
      reserved_credits: account ? account.reserved_credits : 0,
    },
    usage_summary: {
      total_spent: usage.total_spent,
      generation_count: usage.generation_count,
      spent_7d: usage.spent_7d,
    },
    api_keys: keys.map((item) => ({
      id: item.id,
      key_prefix: item.key_prefix,
      status: item.status,
      expires_at: item.expires_at || null,
      last_used_at: item.last_used_at || null,
      created_at: item.created_at,
      note: item.note || '',
    })),
    created_at: customer.created_at,
    updated_at: customer.updated_at,
  };
}

function createApiCustomer({ name, contact = '', note = '' }) {
  return creditsRepository.withLock(() => {
    const state = creditsRepository.readState();
    const now = new Date().toISOString();
    const user = {
      id: crypto.randomUUID(),
      user_token_hash: null,
      api_customer_id: null,
      status: 'active',
      created_at: now,
      updated_at: now,
    };
    const customer = {
      id: crypto.randomUUID(),
      name,
      contact,
      status: 'active',
      note,
      user_id: user.id,
      created_at: now,
      updated_at: now,
    };
    user.api_customer_id = customer.id;
    state.users.push(user);
    state.accounts.push({
      id: crypto.randomUUID(),
      user_id: user.id,
      available_credits: 0,
      reserved_credits: 0,
      created_at: now,
      updated_at: now,
    });
    state.api_customers.push(customer);
    creditsRepository.writeState(state);
    return serializeApiCustomer(state, customer);
  });
}

function createApiKeyForCustomer(customerId, { note = '', expiresAt = null } = {}) {
  return creditsRepository.withLock(() => {
    const state = creditsRepository.readState();
    const customer = (state.api_customers || []).find((item) => item.id === customerId);
    if (!customer) return null;

    const secret = createApiSecret();
    const now = new Date().toISOString();
    const key = {
      id: crypto.randomUUID(),
      customer_id: customer.id,
      key_hash: hashSecret(secret),
      key_prefix: secret.slice(0, 12),
      status: 'active',
      expires_at: expiresAt || null,
      note,
      created_at: now,
      last_used_at: null,
    };
    state.api_keys.push(key);
    customer.updated_at = now;
    creditsRepository.writeState(state);
    return {
      api_key: secret,
      key: serializeApiCustomer(state, customer).api_keys.find((item) => item.id === key.id),
    };
  });
}

function revokeApiKey(keyId) {
  return creditsRepository.withLock(() => {
    const state = creditsRepository.readState();
    const key = (state.api_keys || []).find((item) => item.id === keyId);
    if (!key) return null;
    key.status = 'revoked';
    key.revoked_at = new Date().toISOString();
    creditsRepository.writeState(state);
    return key;
  });
}

function authenticateApiKey(secret) {
  if (!secret) return null;
  const state = creditsRepository.readState();
  const keyHash = hashSecret(secret);
  const key = (state.api_keys || []).find((item) => item.key_hash === keyHash) || null;
  if (!key || key.status !== 'active') return null;
  if (key.expires_at && new Date(key.expires_at).getTime() < Date.now()) return null;
  const customer = (state.api_customers || []).find((item) => item.id === key.customer_id) || null;
  if (!customer || customer.status !== 'active') return null;
  const account = getAccount(state, customer.user_id);
  if (!account) return null;
  return { state, key, customer, account };
}

function touchApiKey(keyId) {
  return creditsRepository.withLock(() => {
    const state = creditsRepository.readState();
    const key = (state.api_keys || []).find((item) => item.id === keyId);
    if (!key) return null;
    key.last_used_at = new Date().toISOString();
    creditsRepository.writeState(state);
    return key;
  });
}

function grantCreditsToEmail(email, credits, note) {
  return creditsRepository.withLock(() => {
    if (!EMAIL_AUTH_ENABLED) {
      return { error: 'email_auth_disabled' };
    }

    const emailState = readEmailAuthState();
    cleanupEmailAuthState(emailState);
    const emailUser = findEmailUserByEmail(emailState, email);
    if (!emailUser) {
      return { error: 'email_user_not_found' };
    }

    const state = creditsRepository.readState();
    const linkedUsers = (state.users || [])
      .filter((item) => item.email_user_id === emailUser.id)
      .sort((left, right) => toTimeOrZero(right.updated_at) - toTimeOrZero(left.updated_at));

    let user = linkedUsers[0] || null;
    let createdUserToken = null;
    const now = new Date().toISOString();

    if (!user) {
      createdUserToken = createPublicToken();
      user = {
        id: crypto.randomUUID(),
        user_token_hash: hashSecret(createdUserToken),
        email_user_id: emailUser.id,
        status: 'active',
        created_at: now,
        updated_at: now,
      };
      state.users.push(user);
    }

    let account = getAccount(state, user.id);
    if (!account) {
      account = {
        id: crypto.randomUUID(),
        user_id: user.id,
        available_credits: 0,
        reserved_credits: 0,
        created_at: now,
        updated_at: now,
      };
      state.accounts.push(account);
    }

    user.email_user_id = user.email_user_id || emailUser.id;
    user.updated_at = now;
    account.available_credits += credits;
    account.updated_at = now;
    appendLedger(state, user.id, 'admin_grant', credits, account, { note });
    creditsRepository.writeState(state);

    return {
      wallet: serializeWallet(state, user.id),
      wallet_user_created: Boolean(createdUserToken),
      created_user_token: createdUserToken,
      wallet_user_id: user.id,
      email_user: serializeEmailUser(emailUser),
    };
  });
}

function createRedemptionBatch({ name, count, creditsPerCode, prefix, expiresAt }) {
  return creditsRepository.withLock(() => {
    const state = creditsRepository.readState();
    const batchId = crypto.randomUUID();
    const now = new Date().toISOString();
    const plainCodes = [];
    const normalizedPrefix = String(prefix || 'IMG').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'IMG';
    const existingHashes = new Set((state.redemption_codes || []).map((item) => item.code_hash));

    const batch = {
      id: batchId,
      name,
      credits_per_code: creditsPerCode,
      code_count: count,
      expires_at: expiresAt,
      created_at: now,
    };
    state.redemption_batches.push(batch);

    for (let i = 0; i < count; i += 1) {
      let code = makeRedemptionCode(normalizedPrefix);
      let codeHash = hashSecret(code);
      let retries = 0;
      while (existingHashes.has(codeHash) && retries < 10) {
        code = makeRedemptionCode(normalizedPrefix);
        codeHash = hashSecret(code);
        retries += 1;
      }
      if (existingHashes.has(codeHash)) {
        throw new Error('failed to generate unique redemption code');
      }

      plainCodes.push(code);
      existingHashes.add(codeHash);
      state.redemption_codes.push({
        id: crypto.randomUUID(),
        batch_id: batchId,
        code_hash: codeHash,
        code_hint: code.slice(0, 8),
        credits: creditsPerCode,
        status: 'active',
        redeemed_by_user_id: null,
        redeemed_at: null,
        revoked_at: null,
        expires_at: expiresAt,
        created_at: now,
      });
    }

    creditsRepository.writeState(state);

    return {
      batch,
      plainCodes,
    };
  });
}

function listRedemptionBatches(limit = 50, stateOverride = null) {
  const state = stateOverride || creditsRepository.readState();
  const byBatch = new Map();
  for (const item of state.redemption_codes || []) {
    if (!byBatch.has(item.batch_id)) {
      byBatch.set(item.batch_id, []);
    }
    byBatch.get(item.batch_id).push(item);
  }

  const batches = (state.redemption_batches || [])
    .slice()
    .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
    .slice(0, limit)
    .map((batch) => {
      const codes = byBatch.get(batch.id) || [];
      return {
        ...batch,
        code_stats: {
          total: codes.length,
          active: codes.filter((item) => item.status === 'active').length,
          redeemed: codes.filter((item) => item.status === 'redeemed').length,
          revoked: codes.filter((item) => item.status === 'revoked').length,
          expired: codes.filter((item) => item.expires_at && new Date(item.expires_at).getTime() < Date.now()).length,
        },
      };
    });
  return batches;
}

function listRedemptionCodes({ batchId, status, limit = 100 }, stateOverride = null) {
  const state = stateOverride || creditsRepository.readState();
  let codes = (state.redemption_codes || []).slice();
  if (batchId) {
    codes = codes.filter((item) => item.batch_id === batchId);
  }
  if (status) {
    codes = codes.filter((item) => item.status === status);
  }
  return codes
    .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
    .slice(0, limit)
    .map(serializeAdminRedemptionCode);
}

function revokeRedemptionCode(codeId, note) {
  return creditsRepository.withLock(() => {
    const state = creditsRepository.readState();
    const code = (state.redemption_codes || []).find((item) => item.id === codeId);
    if (!code) return { error: 'not_found' };
    if (code.status === 'redeemed') return { error: 'already_redeemed' };
    if (code.status === 'revoked') return { error: 'already_revoked' };

    code.status = 'revoked';
    code.revoked_at = new Date().toISOString();
    code.revoked_note = note || null;
    creditsRepository.writeState(state);
    return { code: serializeAdminRedemptionCode(code) };
  });
}

function mapSizeToAspectRatio(size) {
  if (size === '1024x1536') return '2:3';
  if (size === '1536x1024') return '3:2';
  return '1:1';
}

function mapAspectRatioToSize(aspectRatio) {
  if (aspectRatio === '2:3') return '1024x1536';
  if (aspectRatio === '3:2') return '1536x1024';
  return '1024x1024';
}

function normalizeAspectRatio(value) {
  return ['1:1', '2:3', '3:2'].includes(value) ? value : null;
}

function getReplicateCreateUrl() {
  const parts = REPLICATE_MODEL.split('/');
  if (parts.length !== 2 || parts.some((part) => !part)) {
    throw new Error('invalid REPLICATE_MODEL, expected owner/model');
  }
  return `https://api.replicate.com/v1/models/${parts[0]}/${parts[1]}/predictions`;
}

function scheduleJobCleanup(jobId) {
  const timer = setTimeout(() => {
    deletePersistedJob(jobId);
  }, JOB_RETENTION_MS);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
}

function isLikelyImageUrl(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('data:image/')) return true;
  return /^https?:\/\//i.test(trimmed);
}

function collectOutputImageUrls(output) {
  const urls = [];

  function visit(value) {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value === 'string') {
      if (isLikelyImageUrl(value)) urls.push(value.trim());
      return;
    }
    if (typeof value === 'object') {
      Object.values(value).forEach(visit);
    }
  }

  visit(output);
  return [...new Set(urls)];
}

function shouldAuthorizeReplicateOutput(remoteUrl) {
  try {
    const url = new URL(remoteUrl);
    return url.hostname === 'api.replicate.com'
      || url.hostname === 'replicate.delivery'
      || url.hostname.endsWith('.replicate.delivery');
  } catch (_err) {
    return false;
  }
}

async function saveImagesFromUrls(urls, context) {
  const meta = readMeta();
  const images = [];

  for (const remoteUrl of urls) {
    let id = null;
    let storedUrl = remoteUrl;
    let localUrl = null;

    try {
      const headers = shouldAuthorizeReplicateOutput(remoteUrl)
        ? { Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}` }
        : {};
      const buffer = await downloadImageBuffer(remoteUrl, headers);
      const stored = await persistGeneratedImageBuffer(buffer, context, remoteUrl);
      id = stored.id;
      storedUrl = stored.url || remoteUrl;
      localUrl = stored.localUrl;
    } catch (saveErr) {
      console.error('[save error]', saveErr.message);
    }

    if (ENABLE_LOCAL_STORAGE) {
      const record = {
        id,
        prompt: context.prompt,
        size: context.size,
        model: context.model,
        took_ms: context.tookMs,
        local_url: localUrl,
        remote_url: storedUrl,
        source_url: remoteUrl,
        created_at: new Date().toISOString(),
      };
      meta.push(record);
    }

    images.push({
      url: storedUrl,
      b64_json: null,
      local_url: localUrl,
      prompt: context.prompt,
    });
  }

  if (ENABLE_LOCAL_STORAGE) {
    writeMeta(meta);
  }

  return images;
}

async function pollReplicateJob(jobId) {
  const job = jobs.get(jobId);
  if (!job || !job.getUrl) return;

  while (Date.now() - job.createdAt < REPLICATE_MAX_POLL_MS) {
    await new Promise((resolve) => setTimeout(resolve, REPLICATE_POLL_INTERVAL_MS));
    const current = jobs.get(jobId);
    if (!current || isTerminalJobStatus(current.status)) return;

    try {
      const pollController = new AbortController();
      const pollTimer = setTimeout(() => pollController.abort(), UPSTREAM_TIMEOUT_MS);
      let response;
      try {
        response = await fetch(current.getUrl, {
          headers: {
            Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}`,
          },
          signal: pollController.signal,
        });
      } finally {
        clearTimeout(pollTimer);
      }
      const prediction = await response.json();
      if (!response.ok) {
        throw new Error(prediction.detail || `replicate status ${response.status}`);
      }

      current.prediction = prediction;
      current.status = prediction.status || current.status;
      current.updatedAt = Date.now();
      persistJob(current);

      if (current.status === 'succeeded') {
        const tookMs = Date.now() - current.createdAt;
        const output = collectOutputImageUrls(prediction.output);
        const images = await saveImagesFromUrls(output, {
          prompt: current.prompt,
          size: current.size,
          model: REPLICATE_MODEL,
          outputFormat: current.outputFormat,
          tookMs,
        });
        current.images = images;
        let settledWallet = null;
        try {
          settledWallet = await settleCredits(current.creditReservation);
        } catch (settleErr) {
          log('error', 'credits_settle_failed', {
            request_id: current.requestId,
            reservation_id: current.creditReservation ? current.creditReservation.id : null,
            message: settleErr.message,
          });
        }
        current.result = {
          images,
          took_ms: tookMs,
          model: REPLICATE_MODEL,
          prompt: current.prompt,
          provider: 'replicate',
          output: prediction.output || null,
          charged_credits: current.creditReservation ? current.creditReservation.credits : 0,
          wallet: settledWallet,
        };
        current.updatedAt = Date.now();
        persistJob(current);
        log('info', 'replicate_generate_success', {
          request_id: current.requestId,
          job_id: jobId,
          prediction_id: current.predictionId,
          took_ms: tookMs,
          image_count: images.length,
          size: current.size,
          model: REPLICATE_MODEL,
        });
        scheduleJobCleanup(jobId);
        return;
      }

      if (['failed', 'canceled'].includes(current.status)) {
        await safeReleaseCredits(current.creditReservation, `replicate ${current.status}`, current.requestId);
        current.error = prediction.error || 'replicate prediction failed';
        current.updatedAt = Date.now();
        persistJob(current);
        log('error', 'replicate_generate_failed', {
          request_id: current.requestId,
          job_id: jobId,
          prediction_id: current.predictionId,
          status: current.status,
          error: String(current.error).slice(0, 500),
        });
        scheduleJobCleanup(jobId);
        return;
      }
    } catch (e) {
      const current = jobs.get(jobId);
      if (current) {
        await safeReleaseCredits(current.creditReservation, 'replicate poll error', current.requestId);
        current.status = 'failed';
        current.error = e.message;
        current.updatedAt = Date.now();
        persistJob(current);
        scheduleJobCleanup(jobId);
      }
      log('error', 'replicate_poll_error', {
        request_id: current ? current.requestId : null,
        job_id: jobId,
        message: e.message,
      });
      return;
    }
  }

  const current = jobs.get(jobId);
  if (current && !isTerminalJobStatus(current.status)) {
    await safeReleaseCredits(current.creditReservation, 'replicate timed out', current.requestId);
    current.status = 'timed_out';
    current.error = 'replicate prediction timed out';
    current.updatedAt = Date.now();
    persistJob(current);
    scheduleJobCleanup(jobId);
  }
}

function serializeJob(job) {
  return {
    job_id: job.id,
    prediction_id: job.predictionId,
    provider: 'replicate',
    status: job.status,
    error: job.error || null,
    images: job.images || [],
    output: job.prediction ? job.prediction.output || null : null,
    result: job.result || null,
    estimated_credits: job.creditReservation ? job.creditReservation.credits : 0,
    charged_credits: job.result && job.result.charged_credits ? job.result.charged_credits : 0,
    model: REPLICATE_MODEL,
    prompt: job.prompt,
    created_at: new Date(job.createdAt).toISOString(),
    updated_at: job.updatedAt ? new Date(job.updatedAt).toISOString() : null,
  };
}

function countActiveApiJobsForCustomer(customerId) {
  let count = 0;
  for (const job of jobs.values()) {
    if (job.apiCustomerId === customerId && !isTerminalJobStatus(job.status)) count += 1;
  }
  return count;
}

function serializeV1Job(job) {
  const base = serializeJob(job);
  return {
    id: job.id,
    status: job.status,
    provider: base.provider,
    model: base.model,
    aspect_ratio: mapSizeToAspectRatio(job.size),
    images: base.images,
    error: base.error,
    estimated_credits: base.estimated_credits,
    // 仅在成功结算后才报告实扣;失败/超时已释放 credits,这里保持 0,避免账单与钱包不一致。
    charged_credits: base.charged_credits || 0,
    created_at: base.created_at,
    updated_at: base.updated_at,
  };
}

async function createReplicateImageJob(req, {
  prompt,
  size,
  n,
  quality,
  creditReservation,
  apiCustomerId = null,
  apiKeyId = null,
}) {
  const model = REPLICATE_MODEL;
  const outputFormat = 'png';
  const createUrl = getReplicateCreateUrl();
  const response = await fetch(createUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}`,
      Prefer: 'respond-async',
    },
    body: JSON.stringify({
      input: {
        prompt,
        aspect_ratio: mapSizeToAspectRatio(size),
        number_of_images: n,
        quality: process.env.REPLICATE_QUALITY || quality || 'auto',
        background: process.env.REPLICATE_BACKGROUND || 'auto',
        moderation: process.env.REPLICATE_MODERATION || 'auto',
        output_format: outputFormat,
        output_compression: Number(process.env.REPLICATE_OUTPUT_COMPRESSION || 90),
      },
    }),
  });

  const prediction = await response.json();
  if (!response.ok) {
    await safeReleaseCredits(creditReservation, 'replicate create failed', req.requestId);
    log('error', 'replicate_create_error', {
      request_id: req.requestId,
      status: response.status,
      body: JSON.stringify(prediction).slice(0, 500),
    });
    return { error: 'upstream_failed' };
  }

  const jobId = crypto.randomUUID();
  const job = {
    id: jobId,
    provider: 'replicate',
    predictionId: prediction.id,
    getUrl: prediction.urls && prediction.urls.get ? prediction.urls.get : `https://api.replicate.com/v1/predictions/${prediction.id}`,
    status: prediction.status || 'starting',
    prompt,
    size,
    outputFormat,
    creditReservation,
    requestId: req.requestId,
    apiCustomerId,
    apiKeyId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    prediction,
    images: [],
  };
  persistJob(job);
  pollReplicateJob(jobId).catch((e) => {
    const current = jobs.get(jobId);
    if (current) {
      current.status = 'failed';
      current.error = e.message;
      current.updatedAt = Date.now();
      persistJob(current);
    }
  });

  log('info', 'replicate_job_created', {
    request_id: req.requestId,
    job_id: jobId,
    prediction_id: prediction.id,
    api_customer_id: apiCustomerId,
    status: job.status,
    size,
    model,
  });

  return { job };
}

function restoreStoredJobs() {
  if (!ENABLE_LOCAL_STORAGE || PROVIDER_CONFIG.kind !== 'replicate') return;

  let restoredCount = 0;
  let resumedCount = 0;

  for (const item of readStoredJobs()) {
    if (!item || !item.id) continue;
    restoredCount += 1;

    if (item.creditReservation && CREDITS_ENABLED) {
      const state = readCreditsState();
      const account = getAccount(state, item.creditReservation.userId);
      if (!account || account.reserved_credits < item.creditReservation.credits) {
        item.status = 'failed';
        item.error = 'credit reservation inconsistent after restore';
        item.updatedAt = Date.now();
        persistJob(item);
        scheduleJobCleanup(item.id);
        continue;
      }
    }

    jobs.set(item.id, item);
    if (isTerminalJobStatus(item.status)) {
      scheduleJobCleanup(item.id);
      continue;
    }

    resumedCount += 1;
    pollReplicateJob(item.id).catch(async (e) => {
        const current = jobs.get(item.id);
        if (current) {
          await safeReleaseCredits(current.creditReservation, 'restore poll failed', current.requestId);
          current.status = 'failed';
          current.error = e.message;
          current.updatedAt = Date.now();
          persistJob(current);
          scheduleJobCleanup(current.id);
        }
      });
  }

  if (restoredCount > 0) {
    log('info', 'jobs_restored', {
      restored_count: restoredCount,
      resumed_count: resumedCount,
    });
  }
}

function readTokenFromRequest(req) {
  const headerToken = req.headers['x-app-token'];
  if (headerToken && typeof headerToken === 'string') return headerToken;
  const auth = req.headers.authorization;
  if (!auth || typeof auth !== 'string') return '';
  if (!auth.toLowerCase().startsWith('bearer ')) return '';
  return auth.slice(7).trim();
}

function readAdminTokenFromRequest(req) {
  const headerToken = req.headers['x-admin-token'];
  if (headerToken && typeof headerToken === 'string') return headerToken.trim();
  return readTokenFromRequest(req);
}

function sameToken(a, b) {
  if (!a || !b) return false;
  const aBuf = Buffer.from(String(a));
  const bBuf = Buffer.from(String(b));
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function getClientKey(req) {
  const token = readTokenFromRequest(req);
  if (token) {
    return `token:${crypto.createHash('sha256').update(token).digest('hex').slice(0, 12)}`;
  }
  return `ip:${req.ip}`;
}

function ensureDailyQuota(req) {
  const dateKey = new Date().toISOString().slice(0, 10);
  const key = `${getClientKey(req)}:${dateKey}`;
  const used = dailyUsage.get(key) || 0;
  if (used >= DAILY_LIMIT_PER_CLIENT) {
    return false;
  }
  dailyUsage.set(key, used + 1);
  return true;
}

function requireAuth(req, res, next) {
  if (!AUTH_REQUIRED) return next();
  if (!AUTH_TOKEN) {
    return sendError(res, req, 503, 'auth_not_configured', 'service unavailable');
  }
  const token = readTokenFromRequest(req);
  if (!sameToken(token, AUTH_TOKEN)) {
    return sendError(res, req, 401, 'unauthorized', 'missing or invalid access token');
  }
  return next();
}

function requireAdminAuth(req, res, next) {
  if (!ADMIN_TOKEN) {
    return sendError(res, req, 503, 'admin_not_configured', 'admin access is not configured');
  }
  const token = readAdminTokenFromRequest(req);
  if (!sameToken(token, ADMIN_TOKEN)) {
    return sendError(res, req, 401, 'unauthorized', 'missing or invalid admin token');
  }
  return next();
}

function requireApiKeyAuth(req, res, next) {
  if (!CREDITS_ENABLED) {
    return sendError(res, req, 404, 'credits_disabled', 'credits are not enabled');
  }
  const token = readTokenFromRequest(req);
  const auth = authenticateApiKey(token);
  if (!auth) {
    return sendError(res, req, 401, 'unauthorized', 'missing or invalid API key');
  }
  req.apiCustomer = auth.customer;
  req.apiKey = auth.key;
  req.apiUserId = auth.customer.user_id;
  touchApiKey(auth.key.id).catch((err) => {
    log('error', 'api_key_touch_failed', {
      request_id: req.requestId,
      api_key_id: auth.key.id,
      message: err.message,
    });
  });
  return next();
}

function getStoredJobItems() {
  const byId = new Map();
  for (const item of readStoredJobs()) {
    if (item && item.id) byId.set(item.id, item);
  }
  for (const item of jobs.values()) {
    if (item && item.id) byId.set(item.id, item);
  }
  return [...byId.values()];
}

function buildAdminOverview() {
  const gallery = readMeta();
  const jobItems = getStoredJobItems();
  const creditState = creditsRepository.readState();
  const emailState = EMAIL_AUTH_ENABLED ? readEmailAuthState() : emptyEmailAuthState();
  const accounts = creditState.accounts || [];
  const codes = creditState.redemption_codes || [];

  return {
    config: {
      provider: IMAGE_PROVIDER,
      image_storage_provider: IMAGE_STORAGE_PROVIDER,
      credits_enabled: CREDITS_ENABLED,
      email_auth_enabled: EMAIL_AUTH_ENABLED,
      auth_required: AUTH_REQUIRED,
      local_storage_enabled: ENABLE_LOCAL_STORAGE,
      has_required_env: missingEnv.length === 0,
    },
    gallery: {
      total: gallery.length,
      recent: gallery.slice(-10).reverse(),
    },
    jobs: {
      total: jobItems.length,
      by_status: countBy(jobItems, (item) => item.status),
      recent: jobItems
        .slice()
        .sort((left, right) => (right.updatedAt || right.createdAt || 0) - (left.updatedAt || left.createdAt || 0))
        .slice(0, 10)
        .map((item) => ({
          job_id: item.id,
          prediction_id: item.predictionId || null,
          status: item.status || null,
          prompt: item.prompt || null,
          size: item.size || null,
          request_id: item.requestId || null,
          created_at: item.createdAt ? new Date(item.createdAt).toISOString() : null,
          updated_at: item.updatedAt ? new Date(item.updatedAt).toISOString() : null,
        })),
    },
    credits: {
      enabled: CREDITS_ENABLED,
      source: 'file',
      users: (creditState.users || []).length,
      accounts: accounts.length,
      available_credits: accounts.reduce((sum, account) => sum + (account.available_credits || 0), 0),
      reserved_credits: accounts.reduce((sum, account) => sum + (account.reserved_credits || 0), 0),
      ledger_entries: (creditState.credit_ledger || []).length,
      batches: (creditState.redemption_batches || []).length,
      codes: {
        total: codes.length,
        active: codes.filter((item) => item.status === 'active').length,
        redeemed: codes.filter((item) => item.status === 'redeemed').length,
        expired: codes.filter((item) => item.expires_at && new Date(item.expires_at).getTime() < Date.now()).length,
      },
    },
    email_auth: {
      enabled: EMAIL_AUTH_ENABLED,
      users: (emailState.users || []).length,
      active_sessions: (emailState.sessions || []).length,
      pending_codes: (emailState.verification_codes || []).length,
    },
  };
}

// Phase 3a:flag 开启且 DB 可用时,用 DB 聚合覆盖 overview 的 credits 数值。
// 任何失败都保留文件值(回滚兜底),仅打日志 + 标记 source,绝不抛错阻断 overview。
async function applyDbCreditsOverview(overview) {
  if (!DB_READ_CREDITS_OVERVIEW || !overview || !overview.credits) return;
  const pool = getDbPool();
  if (!pool) {
    overview.credits.source = 'file-fallback';
    return;
  }
  try {
    const q = async (sql) => (await pool.query(sql)).rows[0];
    const u = await q('select count(*)::int n from users');
    const w = await q(
      'select count(*)::int n, coalesce(sum(available_credits),0)::int a, coalesce(sum(reserved_credits),0)::int r from wallets'
    );
    const l = await q('select count(*)::int n from credit_ledger');
    const b = await q('select count(*)::int n from redemption_batches');
    const c = await q(
      "select count(*)::int total, count(*) filter (where status='active')::int active, count(*) filter (where status='redeemed')::int redeemed, count(*) filter (where expires_at is not null and expires_at < now())::int expired from redemption_codes"
    );
    overview.credits.users = u.n;
    overview.credits.accounts = w.n;
    overview.credits.available_credits = w.a;
    overview.credits.reserved_credits = w.r;
    overview.credits.ledger_entries = l.n;
    overview.credits.batches = b.n;
    overview.credits.codes = { total: c.total, active: c.active, redeemed: c.redeemed, expired: c.expired };
    overview.credits.source = 'db';
  } catch (err) {
    overview.credits.source = 'file-fallback';
    log('error', 'db_read_credits_overview_failed', { message: err.message });
  }
}

// Phase 3b:flag 开且 DB 可用时,从 DB 取 redemption 状态(batches+codes),供
// listRedemption* 复用同一份 JS 聚合/排序/脱敏 —— 只换数据源,不重写 SQL 逻辑。
// 显式逐字段映射(防 DB 多余列经 batch 的 ...spread 泄漏);时间戳一律走
// dbValueToIso 保毫秒精度;绝不 select code_hash;ORDER BY 保证 DB 侧确定性。
// 失败/不可用返回 null → 调用方回退文件值。
async function loadRedemptionDbState() {
  if (!DB_READ_REDEMPTION_LISTS) return null;
  const pool = getDbPool();
  if (!pool) return null;
  try {
    const batchRows = (await pool.query(
      'select id, name, credits_per_code, code_count, expires_at, created_at from redemption_batches order by created_at, id'
    )).rows;
    const codeRows = (await pool.query(
      'select id, batch_id, code_hint, credits, status, redeemed_by_user_id, redeemed_at, revoked_at, expires_at, created_at from redemption_codes order by created_at, id'
    )).rows;
    return {
      redemption_batches: batchRows.map((b) => ({
        id: b.id,
        name: b.name,
        credits_per_code: b.credits_per_code,
        code_count: b.code_count,
        expires_at: dbValueToIso(b.expires_at),
        created_at: dbValueToIso(b.created_at),
      })),
      redemption_codes: codeRows.map((c) => ({
        id: c.id,
        batch_id: c.batch_id,
        code_hint: c.code_hint || null,
        credits: c.credits,
        status: c.status,
        redeemed_by_user_id: c.redeemed_by_user_id || null,
        redeemed_at: dbValueToIso(c.redeemed_at),
        revoked_at: dbValueToIso(c.revoked_at),
        expires_at: dbValueToIso(c.expires_at),
        created_at: dbValueToIso(c.created_at),
      })),
    };
  } catch (err) {
    log('error', 'db_read_redemption_lists_failed', { message: err.message });
    return null;
  }
}

// Phase 4 Stage C:反向读 —— 从 DB 重建完整 credits state(dualWriteCreditsSnapshot 的逆)。
// 为权威翻转(Stage D)铺路:先用 verify-roundtrip 证明 DB→state 重建与文件态逐字段一致。
// 数组按 created_at,id 稳定排序;时间戳走 dbValueToIso 保毫秒。
// 关键:不读 ledger.reservation_id(文件态无此字段,它是 job_id 的 UUID 派生影子),
// 只用 job_id text 列还原 job_id —— 这正是 migration 002 加该列以保无损往返的原因。
// 失败/不可用返回 null → 调用方回退文件态。
async function loadCreditsStateFromDb() {
  const pool = getDbPool();
  if (!pool) return null;
  try {
    const rows = async (sql) => (await pool.query(sql)).rows;
    const userRows = await rows('select id, user_token_hash, api_customer_id, status, created_at, updated_at from users order by created_at, id');
    const walletRows = await rows('select id, user_id, available_credits, reserved_credits, created_at, updated_at from wallets order by created_at, id');
    const customerRows = await rows('select id, name, contact, status, note, user_id, created_at, updated_at from api_customers order by created_at, id');
    const keyRows = await rows('select id, customer_id, key_hash, key_prefix, status, expires_at, note, last_used_at, revoked_at, created_at from api_keys order by created_at, id');
    const batchRows = await rows('select id, name, credits_per_code, code_count, expires_at, created_at from redemption_batches order by created_at, id');
    const codeRows = await rows('select id, batch_id, code_hash, code_hint, credits, status, redeemed_by_user_id, redeemed_at, revoked_at, revoked_note, expires_at, created_at from redemption_codes order by created_at, id');
    const ledgerRows = await rows('select id, user_id, type, credits_delta, available_after, reserved_after, redemption_code_id, job_id, note, created_at from credit_ledger order by created_at, id');
    return {
      // __STATE_MAP_1__
      users: userRows.map((u) => ({
        id: u.id,
        user_token_hash: u.user_token_hash || null,
        api_customer_id: u.api_customer_id || null,
        status: u.status,
        created_at: dbValueToIso(u.created_at),
        updated_at: dbValueToIso(u.updated_at),
      })),
      accounts: walletRows.map((w) => ({
        id: w.id,
        user_id: w.user_id,
        available_credits: w.available_credits,
        reserved_credits: w.reserved_credits,
        created_at: dbValueToIso(w.created_at),
        updated_at: dbValueToIso(w.updated_at),
      })),
      api_customers: customerRows.map((c) => ({
        id: c.id,
        name: c.name,
        contact: c.contact || '',
        status: c.status,
        note: c.note || '',
        user_id: c.user_id,
        created_at: dbValueToIso(c.created_at),
        updated_at: dbValueToIso(c.updated_at),
      })),
      api_keys: keyRows.map((k) => ({
        id: k.id,
        customer_id: k.customer_id,
        key_hash: k.key_hash,
        key_prefix: k.key_prefix || null,
        status: k.status,
        expires_at: dbValueToIso(k.expires_at),
        note: k.note || '',
        last_used_at: dbValueToIso(k.last_used_at),
        revoked_at: dbValueToIso(k.revoked_at),
        created_at: dbValueToIso(k.created_at),
      })),
      // __STATE_MAP_2__
      redemption_batches: batchRows.map((b) => ({
        id: b.id,
        name: b.name,
        credits_per_code: b.credits_per_code,
        code_count: b.code_count,
        expires_at: dbValueToIso(b.expires_at),
        created_at: dbValueToIso(b.created_at),
      })),
      redemption_codes: codeRows.map((c) => ({
        id: c.id,
        batch_id: c.batch_id,
        code_hash: c.code_hash,
        code_hint: c.code_hint || null,
        credits: c.credits,
        status: c.status,
        redeemed_by_user_id: c.redeemed_by_user_id || null,
        redeemed_at: dbValueToIso(c.redeemed_at),
        revoked_at: dbValueToIso(c.revoked_at),
        revoked_note: c.revoked_note || null,
        expires_at: dbValueToIso(c.expires_at),
        created_at: dbValueToIso(c.created_at),
      })),
      credit_ledger: ledgerRows.map((l) => ({
        id: l.id,
        user_id: l.user_id,
        type: l.type,
        credits_delta: l.credits_delta,
        available_after: l.available_after,
        reserved_after: l.reserved_after,
        job_id: l.job_id || null,
        redemption_code_id: l.redemption_code_id || null,
        note: l.note || null,
        created_at: dbValueToIso(l.created_at),
      })),
    };
  } catch (err) {
    log('error', 'db_read_credits_state_failed', { message: err.message });
    return null;
  }
}

// Phase 4 Stage C:逐字段比对文件态与「DB 反向重建态」,证明往返无损 —— 权威翻转前的硬闸门。
// 只读;按 id 匹配(顺序无关);比较两侧键的并集,undefined 与 null 视为相等
//(DB 重建把缺省字段还原为 null,文件态可能整个不写该字段)。
// 只报告不一致的「集合/id/字段名」,绝不返回字段值 —— 避免泄漏 key_hash/code_hash。
const ROUNDTRIP_COLLECTIONS = [
  'users', 'accounts', 'api_customers', 'api_keys',
  'redemption_batches', 'redemption_codes', 'credit_ledger',
];
function scalarEq(a, b) {
  const na = a === undefined ? null : a;
  const nb = b === undefined ? null : b;
  return na === nb;
}
function diffCreditsStates(fileState, dbState) {
  const SAMPLE = 5;
  const collections = {};
  let ok = true;
  for (const name of ROUNDTRIP_COLLECTIONS) {
    const fileArr = Array.isArray(fileState[name]) ? fileState[name] : [];
    const dbArr = Array.isArray(dbState[name]) ? dbState[name] : [];
    const dbById = new Map(dbArr.map((r) => [r.id, r]));
    const fileIds = new Set(fileArr.map((r) => r.id));
    const missingInDb = [];
    const extraInDb = [];
    const fieldMismatches = [];
    for (const fileRow of fileArr) {
      const dbRow = dbById.get(fileRow.id);
      if (!dbRow) { missingInDb.push(fileRow.id); continue; }
      const keys = new Set([...Object.keys(fileRow), ...Object.keys(dbRow)]);
      for (const k of keys) {
        if (!scalarEq(fileRow[k], dbRow[k]) && fieldMismatches.length < SAMPLE) {
          fieldMismatches.push({ id: fileRow.id, field: k });
        }
      }
    }
    for (const dbRow of dbArr) {
      if (!fileIds.has(dbRow.id)) extraInDb.push(dbRow.id);
    }
    const collOk = missingInDb.length === 0 && extraInDb.length === 0 && fieldMismatches.length === 0;
    if (!collOk) ok = false;
    collections[name] = {
      ok: collOk,
      file_count: fileArr.length,
      db_count: dbArr.length,
      missing_in_db: missingInDb.slice(0, SAMPLE),
      extra_in_db: extraInDb.slice(0, SAMPLE),
      field_mismatches: fieldMismatches,
    };
  }
  return { ok, collections };
}

// Phase 4 Stage D:admin api-customers 只读路径的数据源选择。
// flag 开且 DB 重建成功 → 用 DB 态(source=db);DB 不可用/重建失败 → 回退文件态
// (source=file-fallback);flag 关 → 文件态(source=file)。仅用于只读 admin 报表,
// 容忍异步镜像的有界滞后;计费决策读(鉴权/预扣)绝不走此路径。
async function readApiCustomersState() {
  if (DB_READ_API_CUSTOMERS) {
    const dbState = await loadCreditsStateFromDb();
    if (dbState) return { state: dbState, source: 'db' };
    return { state: creditsRepository.readState(), source: 'file-fallback' };
  }
  return { state: creditsRepository.readState(), source: 'file' };
}

// source 语义与 overview 对齐:flag 关→file;flag 开且读到→db;flag 开但不可用/出错→file-fallback。
function redemptionListSource(dbState) {
  if (dbState) return 'db';
  return DB_READ_REDEMPTION_LISTS ? 'file-fallback' : 'file';
}

// ── 中间件 ──────────────────────────────────────────────
app.set('trust proxy', 1);
app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  req.requestStartAt = Date.now();
  res.setHeader('x-request-id', req.requestId);
  res.on('finish', () => {
    runtimeMetrics.requests_total += 1;
    const statusKey = String(res.statusCode || 0);
    runtimeMetrics.by_status[statusKey] = (runtimeMetrics.by_status[statusKey] || 0) + 1;
    const pathKey = req.route && req.route.path
      ? `${req.method} ${req.baseUrl || ''}${req.route.path}`
      : `${req.method} ${req.path}`;
    runtimeMetrics.by_path[pathKey] = (runtimeMetrics.by_path[pathKey] || 0) + 1;
  });
  next();
});
app.use(express.json({ limit: '2mb' }));
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return sendError(res, req, 400, 'invalid_json', 'invalid JSON request body');
  }
  return next(err);
});
app.use(express.static(path.join(__dirname, 'public')));
if (ENABLE_LOCAL_STORAGE) {
  app.use('/storage', express.static(IMAGE_DIR, {
    fallthrough: false,
    index: false,
    dotfiles: 'deny',
  }));
}

const generateRateLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getClientKey(req),
  handler: (req, res) => {
    sendError(res, req, 429, 'rate_limited', 'too many requests, please retry later');
  },
});

const apiKeyRateLimiter = rateLimit({
  windowMs: API_KEY_RATE_LIMIT_WINDOW_MS,
  max: API_KEY_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.apiKey ? `api-key:${req.apiKey.id}` : getClientKey(req),
  handler: (req, res) => {
    sendError(res, req, 429, 'rate_limited', 'too many API requests, please retry later');
  },
});

// ── 健康检查 ────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({
    status: missingEnv.length > 0 ? 'degraded' : 'ok',
    mode: ENABLE_LOCAL_STORAGE ? 'local-storage' : 'serverless-proxy',
    provider: IMAGE_PROVIDER,
    image_storage_provider: IMAGE_STORAGE_PROVIDER,
    credits_enabled: CREDITS_ENABLED,
    email_auth: {
      enabled: EMAIL_AUTH_ENABLED,
      delivery_configured: EMAIL_DELIVERY_CONFIGURED,
      dev_mode: EMAIL_CODE_DEV_MODE,
    },
    has_required_env: missingEnv.length === 0,
    has_bypass_secret: IMAGE_API_BYPASS_SECRET.length > 0,
  });
});

app.post('/api/auth/email/send-code', async (req, res) => {
  if (!EMAIL_AUTH_ENABLED) {
    return sendError(res, req, 404, 'email_auth_disabled', 'email auth is not enabled');
  }
  if (!EMAIL_CODE_DEV_MODE && !EMAIL_DELIVERY_CONFIGURED) {
    return sendError(res, req, 503, 'email_delivery_not_configured', 'email delivery is not configured');
  }

  const email = normalizeEmail(req.body && req.body.email);
  if (!isValidEmail(email)) {
    return sendError(res, req, 400, 'invalid_email', 'email is invalid');
  }

  return withEmailAuthLock(async () => {
    const state = readEmailAuthState();
    cleanupEmailAuthState(state);
    const now = Date.now();
    const recent = (state.verification_codes || [])
      .filter((item) => item.email === email)
      .sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0))[0];

    if (recent && Date.parse(recent.created_at || 0) + EMAIL_CODE_RESEND_COOLDOWN_MS > now) {
      const retryAfterMs = Date.parse(recent.created_at || 0) + EMAIL_CODE_RESEND_COOLDOWN_MS - now;
      return sendError(res, req, 429, 'code_send_cooldown', 'please wait before requesting another code', {
        retry_after_ms: Math.max(0, retryAfterMs),
      });
    }

    const code = generateEmailCode();
    const codeId = crypto.randomUUID();
    const nowIsoValue = nowIso();
    state.verification_codes.push({
      id: codeId,
      email,
      code_hash: hashEmailAuthSecret(code),
      attempts: 0,
      created_at: nowIsoValue,
      expires_at: new Date(now + EMAIL_CODE_TTL_MS).toISOString(),
      used_at: null,
    });
    writeEmailAuthState(state);

    if (EMAIL_DELIVERY_CONFIGURED) {
      try {
        await sendEmailVerificationCode(email, code);
      } catch (err) {
        state.verification_codes = (state.verification_codes || []).filter((item) => item.id !== codeId);
        writeEmailAuthState(state);
        log('error', 'email_auth_delivery_failed', {
          request_id: req.requestId,
          email_hash: sha256Hex(email).slice(0, 12),
          message: err.message,
          code: err.code || '',
        });
        return sendError(res, req, 502, 'email_delivery_failed', 'failed to send verification email');
      }
    }

    log('info', 'email_auth_code_sent', {
      request_id: req.requestId,
      email_hash: sha256Hex(email).slice(0, 12),
      ttl_ms: EMAIL_CODE_TTL_MS,
    });

    const data = {
      sent: true,
      email,
      expires_in_sec: Math.floor(EMAIL_CODE_TTL_MS / 1000),
    };
    if (EMAIL_CODE_DEV_MODE) {
      data.dev_code = code;
    }
    return sendOk(res, req, data);
  });
});

app.post('/api/auth/email/verify-code', async (req, res) => {
  if (!EMAIL_AUTH_ENABLED) {
    return sendError(res, req, 404, 'email_auth_disabled', 'email auth is not enabled');
  }

  const email = normalizeEmail(req.body && req.body.email);
  const code = String(req.body && req.body.code ? req.body.code : '').trim();
  if (!isValidEmail(email)) {
    return sendError(res, req, 400, 'invalid_email', 'email is invalid');
  }
  if (!/^\d+$/.test(code) || code.length !== EMAIL_CODE_LENGTH) {
    return sendError(res, req, 400, 'invalid_code', `code must be ${EMAIL_CODE_LENGTH} digits`);
  }

  return withEmailAuthLock(() => {
    const state = readEmailAuthState();
    cleanupEmailAuthState(state);
    const now = Date.now();
    const candidate = (state.verification_codes || [])
      .filter((item) => item.email === email && !item.used_at && Date.parse(item.expires_at || 0) > now)
      .sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0))[0];

    if (!candidate) {
      return sendError(res, req, 400, 'code_not_found', 'verification code not found or expired');
    }

    if ((candidate.attempts || 0) >= EMAIL_CODE_MAX_ATTEMPTS) {
      candidate.used_at = nowIso();
      writeEmailAuthState(state);
      return sendError(res, req, 429, 'code_attempts_exceeded', 'verification code attempts exceeded');
    }

    if (candidate.code_hash !== hashEmailAuthSecret(code)) {
      candidate.attempts = (candidate.attempts || 0) + 1;
      writeEmailAuthState(state);
      return sendError(res, req, 401, 'invalid_code', 'verification code is invalid');
    }

    candidate.used_at = nowIso();
    let user = findEmailUserByEmail(state, email);
    if (!user) {
      user = {
        id: crypto.randomUUID(),
        email,
        status: 'active',
        created_at: nowIso(),
        updated_at: nowIso(),
        email_verified_at: nowIso(),
        last_login_at: nowIso(),
      };
      state.users.push(user);
    } else {
      user.updated_at = nowIso();
      user.email_verified_at = user.email_verified_at || nowIso();
      user.last_login_at = nowIso();
    }

    const authToken = `ema_${crypto.randomBytes(24).toString('base64url')}`;
    state.sessions.push({
      id: crypto.randomUUID(),
      user_id: user.id,
      token_hash: hashEmailAuthSecret(authToken),
      created_at: nowIso(),
      last_seen_at: nowIso(),
      expires_at: new Date(Date.now() + EMAIL_SESSION_TTL_MS).toISOString(),
    });

    writeEmailAuthState(state);
    setEmailAuthCookie(res, authToken);

    log('info', 'email_auth_verified', {
      request_id: req.requestId,
      user_id: user.id,
      email_hash: sha256Hex(email).slice(0, 12),
    });

    return sendOk(res, req, {
      user: serializeEmailUser(user),
      auth_token: authToken,
      session_expires_at: new Date(Date.now() + EMAIL_SESSION_TTL_MS).toISOString(),
    });
  });
});

app.get('/api/auth/me', (req, res) => {
  if (!EMAIL_AUTH_ENABLED) {
    return sendError(res, req, 404, 'email_auth_disabled', 'email auth is not enabled');
  }

  const token = readEmailAuthToken(req);
  const state = readEmailAuthState();
  const auth = getEmailAuthSession(state, token);
  if (!auth) {
    return sendError(res, req, 401, 'unauthorized', 'not logged in');
  }

  return sendOk(res, req, {
    user: serializeEmailUser(auth.user),
    session_expires_at: auth.session.expires_at,
  });
});

app.post('/api/auth/logout', async (req, res) => {
  if (!EMAIL_AUTH_ENABLED) {
    return sendError(res, req, 404, 'email_auth_disabled', 'email auth is not enabled');
  }

  const token = readEmailAuthToken(req);
  clearEmailAuthCookie(res);

  if (!token) {
    return sendOk(res, req, { logged_out: true });
  }

  return withEmailAuthLock(() => {
    const state = readEmailAuthState();
    const tokenHash = hashEmailAuthSecret(token);
    state.sessions = (state.sessions || []).filter((item) => item.token_hash !== tokenHash);
    writeEmailAuthState(state);
    return sendOk(res, req, { logged_out: true });
  });
});

app.get('/api/admin/overview', requireAdminAuth, async (req, res) => {
  const overview = buildAdminOverview();
  await applyDbCreditsOverview(overview);
  return sendOk(res, req, overview);
});

// Phase 4 迁移工具:用「与生产完全相同的双写路径」把文件态全量重镜像到 DB,
// 再回读 DB 计数即时自检。用途:迁移 002 后填充新表,或任何镜像漂移时手动重同步。
// 无副作用(不改文件态);经同一串行队列入队,避免与并发 writeState 双写竞态。
app.post('/api/admin/db/resync', requireAdminAuth, async (req, res) => {
  if (!CREDITS_ENABLED) {
    return sendError(res, req, 404, 'credits_disabled', 'credits are not enabled');
  }
  if (!DB_DUAL_WRITE || !DATABASE_URL) {
    return sendError(res, req, 409, 'db_dual_write_disabled', 'DB dual-write is not enabled');
  }
  const pool = getDbPool();
  if (!pool) {
    return sendError(res, req, 503, 'db_unavailable', 'DB pool is not available');
  }
  const state = creditsRepository.readState();
  enqueueCreditsSnapshotDualWrite(state, 'admin_resync');
  await creditsDualWriteQueue;
  // 单条静态 SQL(无插值),回读全 7 集合计数作为即时验证
  const row = (await pool.query(
    `select (select count(*) from users)::int as users,
            (select count(*) from wallets)::int as wallets,
            (select count(*) from credit_ledger)::int as credit_ledger,
            (select count(*) from redemption_batches)::int as redemption_batches,
            (select count(*) from redemption_codes)::int as redemption_codes,
            (select count(*) from api_customers)::int as api_customers,
            (select count(*) from api_keys)::int as api_keys`
  )).rows[0];
  return sendOk(res, req, { resynced: true, db_counts: row });
});

// Phase 4 Stage C:只读往返校验 —— 证明「DB 反向重建态」与文件态逐字段一致。
// 这是权威翻转(Stage D)前的硬闸门:reconcile 只比计数,本端点比每个镜像字段
// (含时间戳毫秒、job_id、api_customer_id)。只报告不一致的 集合/id/字段名,绝不返回值。
app.get('/api/admin/db/verify-roundtrip', requireAdminAuth, async (req, res) => {
  if (!CREDITS_ENABLED) {
    return sendError(res, req, 404, 'credits_disabled', 'credits are not enabled');
  }
  if (!DB_DUAL_WRITE || !DATABASE_URL) {
    return sendError(res, req, 409, 'db_dual_write_disabled', 'DB dual-write is not enabled');
  }
  const dbState = await loadCreditsStateFromDb();
  if (!dbState) {
    return sendError(res, req, 503, 'db_unavailable', 'failed to read state from DB');
  }
  const fileState = creditsRepository.readState();
  const diff = diffCreditsStates(fileState, dbState);
  return sendOk(res, req, diff);
});

app.get('/api/admin/metrics', requireAdminAuth, (req, res) => {
  return sendOk(res, req, {
    started_at: new Date(processStartedAt).toISOString(),
    uptime_ms: Date.now() - processStartedAt,
    requests_total: runtimeMetrics.requests_total,
    errors_total: runtimeMetrics.errors_total,
    by_status: { ...runtimeMetrics.by_status },
    by_path: { ...runtimeMetrics.by_path },
    error_codes: { ...runtimeMetrics.error_codes },
  });
});

app.get('/api/admin/audit-logs', requireAdminAuth, (req, res) => {
  const limitRaw = Number(req.query && req.query.limit);
  const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 20;
  const action = req.query && typeof req.query.action === 'string'
    ? req.query.action.trim()
    : '';
  return sendOk(res, req, readAdminAuditEntries(limit, action));
});

app.get('/api/admin/email-users', requireAdminAuth, (req, res) => {
  if (!EMAIL_AUTH_ENABLED) {
    return sendError(res, req, 404, 'email_auth_disabled', 'email auth is not enabled');
  }

  const query = req.query && typeof req.query.q === 'string'
    ? normalizeEmail(req.query.q)
    : '';
  const limitRaw = Number(req.query && req.query.limit);
  const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;

  const state = readEmailAuthState();
  cleanupEmailAuthState(state);
  writeEmailAuthState(state);
  const creditState = CREDITS_ENABLED ? creditsRepository.readState() : emptyCreditsState();

  const users = (state.users || [])
    .filter((user) => !query || String(user.email || '').includes(query))
    .sort((left, right) => {
      const rightScore = toTimeOrZero(right.last_login_at) || toTimeOrZero(right.email_verified_at) || toTimeOrZero(right.created_at);
      const leftScore = toTimeOrZero(left.last_login_at) || toTimeOrZero(left.email_verified_at) || toTimeOrZero(left.created_at);
      return rightScore - leftScore;
    });

  return sendOk(res, req, {
    total: users.length,
    users: users.slice(0, limit).map((user) => ({
      ...serializeEmailUser(user),
      wallet: summarizeWalletByEmailUserId(creditState, user.id),
    })),
  });
});

app.post('/api/admin/credits/grant', requireAdminAuth, async (req, res) => {
  if (!CREDITS_ENABLED) {
    return sendError(res, req, 404, 'credits_disabled', 'credits are not enabled');
  }

  const userToken = req.body && typeof req.body.user_token === 'string' ? req.body.user_token.trim() : '';
  const credits = req.body ? req.body.credits : null;
  const note = req.body && typeof req.body.note === 'string' ? req.body.note.trim().slice(0, 200) : 'admin grant';

  if (!userToken) {
    return sendError(res, req, 400, 'invalid_user_token', 'user_token is required');
  }
  if (!Number.isInteger(credits) || credits < 1 || credits > ADMIN_GRANT_MAX_CREDITS) {
    return sendError(res, req, 400, 'invalid_credits', `credits must be an integer between 1 and ${ADMIN_GRANT_MAX_CREDITS}`);
  }

  const wallet = await grantCreditsToUserToken(userToken, credits, note || 'admin grant');
  if (!wallet) {
    return sendError(res, req, 404, 'wallet_not_found', 'wallet not found');
  }

  log('info', 'admin_credits_granted', {
    request_id: req.requestId,
    credits,
    note_hash: sha256Hex(note || 'admin grant').slice(0, 12),
  });
  appendAdminAudit('admin_credits_grant', req, {
    credits,
    note_hash: sha256Hex(note || 'admin grant').slice(0, 12),
  });

  return sendOk(res, req, {
    credits_added: credits,
    wallet,
  });
});

app.post('/api/admin/credits/grant-by-email', requireAdminAuth, async (req, res) => {
  if (!CREDITS_ENABLED) {
    return sendError(res, req, 404, 'credits_disabled', 'credits are not enabled');
  }
  if (!EMAIL_AUTH_ENABLED) {
    return sendError(res, req, 404, 'email_auth_disabled', 'email auth is not enabled');
  }

  const email = normalizeEmail(req.body && typeof req.body.email === 'string' ? req.body.email : '');
  const credits = req.body ? req.body.credits : null;
  const note = req.body && typeof req.body.note === 'string' ? req.body.note.trim().slice(0, 200) : 'admin grant by email';

  if (!isValidEmail(email)) {
    return sendError(res, req, 400, 'invalid_email', 'email is invalid');
  }
  if (!Number.isInteger(credits) || credits < 1 || credits > ADMIN_GRANT_MAX_CREDITS) {
    return sendError(res, req, 400, 'invalid_credits', `credits must be an integer between 1 and ${ADMIN_GRANT_MAX_CREDITS}`);
  }

  const granted = await grantCreditsToEmail(email, credits, note || 'admin grant by email');
  if (granted && granted.error === 'email_user_not_found') {
    return sendError(res, req, 404, 'email_user_not_found', 'email user not found');
  }

  log('info', 'admin_credits_granted_by_email', {
    request_id: req.requestId,
    credits,
    email_hash: sha256Hex(email).slice(0, 12),
    note_hash: sha256Hex(note || 'admin grant by email').slice(0, 12),
    wallet_user_created: Boolean(granted && granted.wallet_user_created),
  });
  appendAdminAudit('admin_credits_grant_by_email', req, {
    credits,
    email_hash: sha256Hex(email).slice(0, 12),
    note_hash: sha256Hex(note || 'admin grant by email').slice(0, 12),
    wallet_user_created: Boolean(granted && granted.wallet_user_created),
  });

  return sendOk(res, req, {
    email,
    credits_added: credits,
    wallet: granted.wallet,
    wallet_user_id: granted.wallet_user_id,
    wallet_user_created: granted.wallet_user_created,
    created_user_token: granted.created_user_token,
  });
});

app.post('/api/admin/redemption-batches', requireAdminAuth, async (req, res) => {
  if (!CREDITS_ENABLED) {
    return sendError(res, req, 404, 'credits_disabled', 'credits are not enabled');
  }

  const name = req.body && typeof req.body.name === 'string' ? req.body.name.trim() : '';
  const count = req.body ? req.body.count : null;
  const creditsPerCode = req.body ? req.body.credits_per_code : null;
  const prefix = req.body && typeof req.body.prefix === 'string' ? req.body.prefix.trim() : 'IMG';
  const expiresAtRaw = req.body && typeof req.body.expires_at === 'string' ? req.body.expires_at.trim() : '';
  const expiresAt = expiresAtRaw ? new Date(expiresAtRaw).toISOString() : null;

  if (!name) {
    return sendError(res, req, 400, 'invalid_name', 'name is required');
  }
  if (!Number.isInteger(count) || count < 1 || count > ADMIN_BATCH_MAX_CODES) {
    return sendError(res, req, 400, 'invalid_count', `count must be an integer between 1 and ${ADMIN_BATCH_MAX_CODES}`);
  }
  if (!Number.isInteger(creditsPerCode) || creditsPerCode < 1 || creditsPerCode > ADMIN_BATCH_MAX_CREDITS_PER_CODE) {
    return sendError(res, req, 400, 'invalid_credits_per_code', `credits_per_code must be an integer between 1 and ${ADMIN_BATCH_MAX_CREDITS_PER_CODE}`);
  }
  if (expiresAtRaw && Number.isNaN(Date.parse(expiresAtRaw))) {
    return sendError(res, req, 400, 'invalid_expires_at', 'expires_at must be a valid ISO datetime string');
  }

  const created = await createRedemptionBatch({
    name,
    count,
    creditsPerCode,
    prefix,
    expiresAt,
  });

  log('info', 'admin_redemption_batch_created', {
    request_id: req.requestId,
    batch_id: created.batch.id,
    code_count: count,
    credits_per_code: creditsPerCode,
  });
  appendAdminAudit('admin_redemption_batch_create', req, {
    batch_id: created.batch.id,
    code_count: count,
    credits_per_code: creditsPerCode,
  });

  return sendOk(res, req, {
    batch: created.batch,
    codes: created.plainCodes,
  }, 201);
});

app.get('/api/admin/redemption-batches', requireAdminAuth, async (req, res) => {
  if (!CREDITS_ENABLED) {
    return sendError(res, req, 404, 'credits_disabled', 'credits are not enabled');
  }
  const limit = Number(req.query && req.query.limit) || 50;
  const safeLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 200) : 50;
  const dbState = await loadRedemptionDbState();
  return sendOk(res, req, {
    batches: listRedemptionBatches(safeLimit, dbState),
    source: redemptionListSource(dbState),
  });
});

app.get('/api/admin/redemption-codes', requireAdminAuth, async (req, res) => {
  if (!CREDITS_ENABLED) {
    return sendError(res, req, 404, 'credits_disabled', 'credits are not enabled');
  }
  const batchId = req.query && typeof req.query.batch_id === 'string' ? req.query.batch_id : '';
  const status = req.query && typeof req.query.status === 'string' ? req.query.status : '';
  const limit = Number(req.query && req.query.limit) || 100;
  const safeLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 500) : 100;
  const dbState = await loadRedemptionDbState();
  return sendOk(res, req, {
    codes: listRedemptionCodes({ batchId, status, limit: safeLimit }, dbState),
    source: redemptionListSource(dbState),
  });
});

app.post('/api/admin/redemption-codes/:id/revoke', requireAdminAuth, async (req, res) => {
  if (!CREDITS_ENABLED) {
    return sendError(res, req, 404, 'credits_disabled', 'credits are not enabled');
  }
  const codeId = req.params.id;
  const note = req.body && typeof req.body.note === 'string' ? req.body.note.trim().slice(0, 200) : '';
  const result = await revokeRedemptionCode(codeId, note);
  if (result.error === 'not_found') {
    return sendError(res, req, 404, 'code_not_found', 'redemption code not found');
  }
  if (result.error === 'already_redeemed') {
    return sendError(res, req, 409, 'code_already_redeemed', 'redemption code already redeemed');
  }
  if (result.error === 'already_revoked') {
    return sendError(res, req, 409, 'code_already_revoked', 'redemption code already revoked');
  }

  log('info', 'admin_redemption_code_revoked', {
    request_id: req.requestId,
    code_id: codeId,
    note_hash: sha256Hex(note || '').slice(0, 12),
  });
  appendAdminAudit('admin_redemption_code_revoke', req, {
    code_id: codeId,
    note_hash: sha256Hex(note || '').slice(0, 12),
  });

  return sendOk(res, req, {
    code: result.code,
  });
});

// ── 客户 API：Admin 管理路由 ───────────────────────────
app.post('/api/admin/api-customers', requireAdminAuth, async (req, res) => {
  if (!CREDITS_ENABLED) {
    return sendError(res, req, 404, 'credits_disabled', 'credits are not enabled');
  }
  const name = req.body && typeof req.body.name === 'string' ? req.body.name.trim() : '';
  const contact = req.body && typeof req.body.contact === 'string' ? req.body.contact.trim().slice(0, 200) : '';
  const note = req.body && typeof req.body.note === 'string' ? req.body.note.trim().slice(0, 200) : '';
  if (!name) {
    return sendError(res, req, 400, 'invalid_name', 'name is required');
  }

  const customer = await createApiCustomer({ name, contact, note });

  log('info', 'admin_api_customer_created', {
    request_id: req.requestId,
    customer_id: customer.id,
  });
  appendAdminAudit('admin_api_customer_create', req, {
    customer_id: customer.id,
  });

  return sendOk(res, req, customer, 201);
});

app.get('/api/admin/api-customers', requireAdminAuth, async (req, res) => {
  if (!CREDITS_ENABLED) {
    return sendError(res, req, 404, 'credits_disabled', 'credits are not enabled');
  }
  const { state, source } = await readApiCustomersState();
  const customers = (state.api_customers || []).map((customer) => serializeApiCustomer(state, customer));
  return sendOk(res, req, { customers, source });
});

app.get('/api/admin/api-customers/:id/usage', requireAdminAuth, async (req, res) => {
  if (!CREDITS_ENABLED) {
    return sendError(res, req, 404, 'credits_disabled', 'credits are not enabled');
  }
  const { state, source } = await readApiCustomersState();
  const customer = (state.api_customers || []).find((item) => item.id === req.params.id);
  if (!customer) {
    return sendError(res, req, 404, 'customer_not_found', 'api customer not found');
  }
  const usage = summarizeCustomerUsage(state, customer.user_id);
  return sendOk(res, req, {
    customer_id: customer.id,
    source,
    ...usage,
  });
});

app.post('/api/admin/api-customers/:id/api-keys', requireAdminAuth, async (req, res) => {
  if (!CREDITS_ENABLED) {
    return sendError(res, req, 404, 'credits_disabled', 'credits are not enabled');
  }
  const note = req.body && typeof req.body.note === 'string' ? req.body.note.trim().slice(0, 200) : '';
  const rawExpiresAt = req.body && typeof req.body.expires_at === 'string' ? req.body.expires_at.trim() : '';
  let expiresAt = null;
  if (rawExpiresAt) {
    const parsed = Date.parse(rawExpiresAt);
    // 无效日期会让鉴权处的 `NaN < now` 恒为 false,等于 key 永不过期 —— 必须显式拒绝。
    if (Number.isNaN(parsed)) {
      return sendError(res, req, 400, 'invalid_expires_at', 'expires_at must be a valid ISO date');
    }
    if (parsed <= Date.now()) {
      return sendError(res, req, 400, 'invalid_expires_at', 'expires_at must be in the future');
    }
    expiresAt = new Date(parsed).toISOString();
  }

  const result = await createApiKeyForCustomer(req.params.id, { note, expiresAt });
  if (!result) {
    return sendError(res, req, 404, 'customer_not_found', 'api customer not found');
  }

  log('info', 'admin_api_key_created', {
    request_id: req.requestId,
    customer_id: req.params.id,
    key_id: result.key.id,
  });
  appendAdminAudit('admin_api_key_create', req, {
    customer_id: req.params.id,
  });

  return sendOk(res, req, result, 201);
});

app.post('/api/admin/api-customers/:id/credits/grant', requireAdminAuth, async (req, res) => {
  if (!CREDITS_ENABLED) {
    return sendError(res, req, 404, 'credits_disabled', 'credits are not enabled');
  }
  const credits = req.body ? req.body.credits : null;
  const note = req.body && typeof req.body.note === 'string' ? req.body.note.trim().slice(0, 200) : 'admin grant';
  if (!Number.isInteger(credits) || credits < 1 || credits > ADMIN_GRANT_MAX_CREDITS) {
    return sendError(res, req, 400, 'invalid_credits', `credits must be an integer between 1 and ${ADMIN_GRANT_MAX_CREDITS}`);
  }

  const state = creditsRepository.readState();
  const customer = (state.api_customers || []).find((item) => item.id === req.params.id);
  if (!customer) {
    return sendError(res, req, 404, 'customer_not_found', 'api customer not found');
  }

  const wallet = await grantCreditsToUserId(customer.user_id, credits, note || 'admin grant');
  if (!wallet) {
    return sendError(res, req, 404, 'wallet_not_found', 'wallet not found');
  }

  log('info', 'admin_api_customer_granted', {
    request_id: req.requestId,
    customer_id: req.params.id,
    credits,
    note_hash: sha256Hex(note || 'admin grant').slice(0, 12),
  });
  appendAdminAudit('admin_api_customer_grant', req, {
    customer_id: req.params.id,
    credits,
    note_hash: sha256Hex(note || 'admin grant').slice(0, 12),
  });

  return sendOk(res, req, {
    credits_added: credits,
    wallet,
  });
});

app.post('/api/admin/api-keys/:id/revoke', requireAdminAuth, async (req, res) => {
  if (!CREDITS_ENABLED) {
    return sendError(res, req, 404, 'credits_disabled', 'credits are not enabled');
  }
  const key = await revokeApiKey(req.params.id);
  if (!key) {
    return sendError(res, req, 404, 'key_not_found', 'api key not found');
  }

  log('info', 'admin_api_key_revoked', {
    request_id: req.requestId,
    key_id: req.params.id,
  });
  appendAdminAudit('admin_api_key_revoke', req, {
    key_id: req.params.id,
  });

  return sendOk(res, req, {
    revoked: true,
    key_id: req.params.id,
  });
});

app.post('/api/redeem', async (req, res) => {
  if (!CREDITS_ENABLED) {
    return sendError(res, req, 404, 'credits_disabled', 'credits are not enabled');
  }

  const code = req.body && typeof req.body.code === 'string' ? req.body.code.trim() : '';
  if (!code) {
    return sendError(res, req, 400, 'invalid_code', 'redemption code is required');
  }

  const emailAuthUser = getEmailAuthUserFromRequest(req);

  return creditsRepository.withLock(() => {
    const state = creditsRepository.readState();
    const codeHash = hashSecret(code);
    const redemptionCode = state.redemption_codes.find((item) => item.code_hash === codeHash);
    if (!redemptionCode) {
      return sendError(res, req, 404, 'code_not_found', 'redemption code not found');
    }
    if (redemptionCode.status === 'redeemed') {
      return sendError(res, req, 409, 'code_already_redeemed', 'redemption code already redeemed');
    }
    if (redemptionCode.status !== 'active') {
      return sendError(res, req, 409, 'code_not_active', 'redemption code is not active');
    }
    if (redemptionCode.expires_at && new Date(redemptionCode.expires_at).getTime() < Date.now()) {
      return sendError(res, req, 410, 'code_expired', 'redemption code expired');
    }

    let userToken = getUserToken(req);
    let user = findUserByToken(state, userToken);
    if (!user) {
      userToken = createPublicToken();
      user = {
        id: crypto.randomUUID(),
        user_token_hash: hashSecret(userToken),
        email_user_id: emailAuthUser ? emailAuthUser.id : null,
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      state.users.push(user);
      state.accounts.push({
        id: crypto.randomUUID(),
        user_id: user.id,
        available_credits: 0,
        reserved_credits: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }

    if (emailAuthUser && !user.email_user_id) {
      user.email_user_id = emailAuthUser.id;
      user.updated_at = new Date().toISOString();
    }

    const account = getAccount(state, user.id);
    account.available_credits += redemptionCode.credits;
    account.updated_at = new Date().toISOString();
    redemptionCode.status = 'redeemed';
    redemptionCode.redeemed_by_user_id = user.id;
    redemptionCode.redeemed_at = new Date().toISOString();
    appendLedger(state, user.id, 'redeem', redemptionCode.credits, account, {
      redemptionCodeId: redemptionCode.id,
    });
    creditsRepository.writeState(state);

    return sendOk(res, req, {
      user_token: userToken,
      credits_added: redemptionCode.credits,
      ...serializeWallet(state, user.id),
    });
  });
});

app.get('/api/wallet', (req, res) => {
  if (!CREDITS_ENABLED) {
    return sendError(res, req, 404, 'credits_disabled', 'credits are not enabled');
  }
  const userToken = getUserToken(req);
  const state = creditsRepository.readState();
  const user = findUserByToken(state, userToken);
  if (!user) {
    return sendError(res, req, 401, 'wallet_required', 'wallet not found');
  }
  return sendOk(res, req, serializeWallet(state, user.id));
});

app.get('/api/jobs/:id', requireAuth, (req, res) => {
  const job = jobs.get(req.params.id);
  // API 客户的任务必须经 /v1/images/jobs/:id 查询;网页接口不暴露其归属信息,避免跨客户读取。
  if (!job || job.apiCustomerId) {
    return sendError(res, req, 404, 'job_not_found', 'job not found');
  }
  return sendOk(res, req, serializeJob(job));
});

// ── 核心：生图接口 ──────────────────────────────────────
app.post('/api/generate', generateRateLimiter, requireAuth, async (req, res) => {
  const start = Date.now();
  const { prompt, size = '1024x1024', n = 1 } = req.body || {};
  // 统一画质与计费:网页端固定按 auto 出图并扣 20 credits,忽略请求体里的 quality,
  // 从源头消除“选低档→低扣费、但实际仍生成 auto 画质”的套利(与 /v1 接口一致)。
  const quality = 'auto';

  if (typeof prompt !== 'string') {
    return sendError(res, req, 400, 'invalid_prompt', 'prompt must be a string');
  }

  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt) {
    return sendError(res, req, 400, 'invalid_prompt', 'prompt is required');
  }
  if (normalizedPrompt.length > MAX_PROMPT_CHARS) {
    return sendError(
      res,
      req,
      400,
      'prompt_too_long',
      `prompt too long (max ${MAX_PROMPT_CHARS} chars)`
    );
  }

  if (!ALLOWED_SIZES.has(size)) {
    return sendError(res, req, 400, 'invalid_size', 'unsupported image size');
  }

  const pixels = parsePixels(size);
  if (pixels > MAX_PIXEL_COUNT) {
    return sendError(res, req, 400, 'size_too_large', 'image size exceeds allowed limit');
  }

  if (!Number.isInteger(n) || n < 1 || n > MAX_IMAGES_PER_REQUEST) {
    return sendError(
      res,
      req,
      400,
      'invalid_count',
      `n must be an integer between 1 and ${MAX_IMAGES_PER_REQUEST}`
    );
  }

  if (missingEnv.length > 0) {
    log('error', 'config_error_missing_env', {
      request_id: req.requestId,
      missing_env: missingEnv,
    });
    return sendError(res, req, 500, 'service_unavailable', 'service unavailable');
  }

  if (!ensureDailyQuota(req)) {
    return sendError(res, req, 429, 'quota_exceeded', 'daily generation quota exceeded');
  }

  const creditReservation = await reserveCreditsForRequest(req, res, quality, n);
  if (creditReservation === false) {
    return;
  }

  if (PROVIDER_CONFIG.kind === 'replicate') {
    try {
      const created = await createReplicateImageJob(req, {
        prompt: normalizedPrompt,
        size,
        n,
        quality,
        creditReservation,
      });
      if (created.error) {
        return sendError(res, req, 502, 'upstream_failed', 'unable to create replicate prediction');
      }
      return sendOk(res, req, serializeJob(created.job), 202);
    } catch (e) {
      await safeReleaseCredits(creditReservation, 'replicate create exception', req.requestId);
      log('error', 'replicate_create_exception', {
        request_id: req.requestId,
        message: e.message,
      });
      return sendError(res, req, 500, 'internal_error', 'internal error');
    }
  }

  let timeout = null;
  try {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

    const upstreamUrl = new URL('/v1/images/generations', PROVIDER_CONFIG.apiBase);
    const upstream = await fetch(
      upstreamUrl,
      {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${PROVIDER_CONFIG.apiKey}`,
          ...(IMAGE_API_BYPASS_SECRET ? { 'X-Internal-Bypass': IMAGE_API_BYPASS_SECRET } : {}),
        },
        body: JSON.stringify({
          model: PROVIDER_CONFIG.apiModel,
          prompt: normalizedPrompt,
          size,
          n,
          response_format: IMAGE_STORAGE_PROVIDER === 'none' ? 'url' : 'b64_json',
        }),
      }
    );

    if (!upstream.ok) {
      const err = await upstream.text();
      await safeReleaseCredits(creditReservation, 'upstream failed', req.requestId);
      log('error', 'upstream_error', {
        request_id: req.requestId,
        status: upstream.status,
        upstream_host: upstreamUrl.host,
        upstream_cf_ray: upstream.headers.get('cf-ray'),
        upstream_cf_mitigated: upstream.headers.get('cf-mitigated'),
        upstream_server: upstream.headers.get('server'),
        upstream_content_type: upstream.headers.get('content-type'),
        has_bypass_secret: IMAGE_API_BYPASS_SECRET.length > 0,
        bypass_secret_hash: IMAGE_API_BYPASS_SECRET_HASH,
        body: err.slice(0, 500),
      });
      return sendError(res, req, 502, 'upstream_failed', 'unable to generate image');
    }

    const json = await upstream.json();
    const took_ms = Date.now() - start;
    const model = PROVIDER_CONFIG.apiModel;
    const meta = readMeta();
    const images = [];

    for (const d of (json.data || [])) {
      let storedUrl = d.url || null;
      let localUrl = null;
      let id = null;

      if (IMAGE_STORAGE_PROVIDER !== 'none') {
        try {
          let buffer = null;
          if (d.b64_json) {
            buffer = Buffer.from(d.b64_json, 'base64');
          } else if (d.url) {
            buffer = await downloadImageBuffer(d.url);
          }

          if (!buffer) {
            throw new Error('upstream returned no image data');
          }

          const stored = await persistGeneratedImageBuffer(buffer, {
            prompt: normalizedPrompt,
            size,
            model,
            outputFormat: 'png',
            tookMs: took_ms,
          }, d.url || null);
          id = stored.id;
          storedUrl = stored.url;
          localUrl = stored.localUrl;
        } catch (saveErr) {
          console.error('[save error]', saveErr.message);
          if (IMAGE_STORAGE_PROVIDER === 's3' && !d.url) {
            throw saveErr;
          }
        }
      }

      if (ENABLE_LOCAL_STORAGE) {
        const record = {
          id,
          prompt: normalizedPrompt,
          size,
          model,
          took_ms,
          local_url: localUrl,
          remote_url: storedUrl,
          source_url: d.url || null,
          created_at: new Date().toISOString(),
        };
        meta.push(record);
      }

      images.push({
        url: storedUrl,
        b64_json: null,
        local_url: localUrl,
        prompt: normalizedPrompt,
      });
    }

    if (ENABLE_LOCAL_STORAGE) {
      writeMeta(meta);
    }

    let wallet = null;
    try {
      wallet = await settleCredits(creditReservation);
    } catch (settleErr) {
      log('error', 'credits_settle_failed', {
        request_id: req.requestId,
        reservation_id: creditReservation ? creditReservation.id : null,
        message: settleErr.message,
      });
    }

    log('info', 'generate_success', {
      request_id: req.requestId,
      took_ms,
      image_count: images.length,
      size,
      model,
    });

    return sendOk(res, req, {
      images,
      took_ms,
      model,
      prompt: normalizedPrompt,
      charged_credits: creditReservation ? creditReservation.credits : 0,
      wallet,
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      await safeReleaseCredits(creditReservation, 'upstream timeout', req.requestId);
      log('error', 'upstream_timeout', {
        request_id: req.requestId,
        timeout_ms: UPSTREAM_TIMEOUT_MS,
      });
      return sendError(res, req, 504, 'upstream_timeout', 'upstream request timed out');
    }
    await safeReleaseCredits(creditReservation, 'internal error', req.requestId);
    log('error', 'generate_error', {
      request_id: req.requestId,
      message: e.message,
      stack: e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : null,
    });
    return sendError(res, req, 500, 'internal_error', 'internal error');
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
});

// ── 画廊接口：返回历史生成记录 ─────────────────────────
app.get('/api/gallery', (_req, res) => {
  if (!ENABLE_LOCAL_STORAGE) {
    return res.json({ success: true, data: [], request_id: null });
  }
  const meta = readMeta();
  return res.json({ success: true, data: meta.slice().reverse(), request_id: null });
});

// ── 客户 API：V1 生图接口 ──────────────────────────────
app.post('/v1/images/generations', requireApiKeyAuth, apiKeyRateLimiter, async (req, res) => {
  const prompt = req.body ? req.body.prompt : undefined;
  if (typeof prompt !== 'string') {
    return sendError(res, req, 400, 'invalid_prompt', 'prompt must be a string');
  }
  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt) {
    return sendError(res, req, 400, 'invalid_prompt', 'prompt is required');
  }
  if (normalizedPrompt.length > MAX_PROMPT_CHARS) {
    return sendError(res, req, 400, 'prompt_too_long', `prompt too long (max ${MAX_PROMPT_CHARS} chars)`);
  }

  const ar = normalizeAspectRatio((req.body && req.body.aspect_ratio) || '1:1');
  if (!ar) {
    return sendError(res, req, 400, 'invalid_aspect_ratio', 'unsupported aspect ratio');
  }
  const size = mapAspectRatioToSize(ar);

  if (missingEnv.length > 0) {
    log('error', 'config_error_missing_env', {
      request_id: req.requestId,
      missing_env: missingEnv,
    });
    return sendError(res, req, 500, 'service_unavailable', 'service unavailable');
  }

  if (PROVIDER_CONFIG.kind !== 'replicate') {
    return sendError(res, req, 503, 'provider_unsupported', 'image provider does not support the customer API');
  }

  if (countActiveApiJobsForCustomer(req.apiCustomer.id) >= API_CUSTOMER_MAX_CONCURRENT_JOBS) {
    return sendError(res, req, 409, 'api_concurrency_limited', 'previous job still running');
  }

  const reservation = await reserveCreditsForUserId(req.apiUserId, 'auto', 1);
  if (reservation && reservation.error === 'wallet_required') {
    return sendError(res, req, 500, 'internal_error', 'wallet not provisioned');
  }
  if (reservation && reservation.error === 'insufficient_credits') {
    return sendError(res, req, 402, 'insufficient_credits', 'not enough credits', {
      required_credits: reservation.required_credits,
      available_credits: reservation.available_credits,
    });
  }

  try {
    const created = await createReplicateImageJob(req, {
      prompt: normalizedPrompt,
      size,
      n: 1,
      quality: 'auto',
      creditReservation: reservation,
      apiCustomerId: req.apiCustomer.id,
      apiKeyId: req.apiKey.id,
    });
    if (created.error) {
      return sendError(res, req, 502, 'upstream_failed', 'unable to create replicate prediction');
    }
    return sendOk(res, req, {
      id: created.job.id,
      status: created.job.status,
      charged_credits: reservation ? reservation.credits : 0,
      poll_url: `/v1/images/jobs/${created.job.id}`,
    }, 202);
  } catch (e) {
    await safeReleaseCredits(reservation, 'v1 create exception', req.requestId);
    log('error', 'v1_create_exception', {
      request_id: req.requestId,
      message: e.message,
    });
    return sendError(res, req, 500, 'internal_error', 'internal error');
  }
});

app.get('/v1/images/jobs/:id', requireApiKeyAuth, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.apiCustomerId !== req.apiCustomer.id) {
    return sendError(res, req, 404, 'job_not_found', 'job not found');
  }
  return sendOk(res, req, serializeV1Job(job));
});

app.use('/api', (req, res) => {
  return sendError(res, req, 404, 'not_found', 'api endpoint not found');
});

// ── 启动 ────────────────────────────────────────────────
restoreStoredJobs();

if (require.main === module) {
  app.listen(PORT, () => console.log(`Image Studio running -> http://localhost:${PORT}`));
}

// 只读纯函数,挂在 app 上供测试做日期分桶/边界断言;不改变默认导出形状。
app.summarizeCustomerUsage = summarizeCustomerUsage;
// dual-write 的 uuid 列守卫,挂出供单测验证非 UUID 值降级为 null。
app.asUuidOrNull = asUuidOrNull;

module.exports = app;
