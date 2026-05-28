require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

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
  '1920x1080',
  '2560x1440',
  '3840x2160',
  'auto',
]);
const MAX_PROMPT_CHARS = Number(process.env.MAX_PROMPT_CHARS || 4000);
const MAX_IMAGES_PER_REQUEST = Number(process.env.MAX_IMAGES_PER_REQUEST || 1);
const MAX_PIXEL_COUNT = Number(process.env.MAX_PIXEL_COUNT || 8300000); // covers 4K (3840x2160)
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

if (CREDITS_ENABLED && (!process.env.CREDIT_CODE_PEPPER || CREDIT_CODE_PEPPER === 'change-me')) {
  throw new Error(
    'CREDIT_CODE_PEPPER must be set to a strong random value when CREDITS_ENABLED=true; default value is rejected.'
  );
}
const CREDIT_COSTS = {
  low: Number(process.env.CREDIT_COST_REPLICATE_GPT_IMAGE_2_LOW || 3),
  medium: Number(process.env.CREDIT_COST_REPLICATE_GPT_IMAGE_2_MEDIUM || 8),
  auto: Number(process.env.CREDIT_COST_REPLICATE_GPT_IMAGE_2_AUTO || 20),
  high: Number(process.env.CREDIT_COST_REPLICATE_GPT_IMAGE_2_HIGH || 20),
};

const dailyUsage = new Map();
const jobs = new Map();
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
}

if (CREDITS_ENABLED) {
  ensureCreditsFile();
}

let creditsMutex = Promise.resolve();
function withCreditsLock(fn) {
  const next = creditsMutex.then(() => fn());
  creditsMutex = next.catch(() => {});
  return next;
}

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

function sendOk(res, req, data, status = 200) {
  return res.status(status).json({
    success: true,
    data,
    request_id: req.requestId,
  });
}

function sendError(res, req, status, code, message, details) {
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

function parsePixels(size) {
  if (!size || size === 'auto') return 0;
  const parts = size.split('x').map(Number);
  if (parts.length !== 2 || parts.some((v) => Number.isNaN(v))) return -1;
  return parts[0] * parts[1];
}

function hashSecret(value) {
  return crypto.createHash('sha256').update(`${CREDIT_CODE_PEPPER}:${value}`).digest('hex');
}

function createPublicToken() {
  return `usr_${crypto.randomBytes(24).toString('base64url')}`;
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

function reserveCreditsForRequest(req, res, quality, n) {
  if (!CREDITS_ENABLED) return null;
  return withCreditsLock(() => {
    const userToken = getUserToken(req);
    const state = readCreditsState();
    const user = findUserByToken(state, userToken);
    if (!user) {
      sendError(res, req, 401, 'wallet_required', 'redeem a code before generating images');
      return false;
    }
    const account = getAccount(state, user.id);
    if (!account) {
      sendError(res, req, 401, 'wallet_required', 'wallet not found');
      return false;
    }

    const cost = getCreditCost(quality, n);
    if (account.available_credits < cost.credits) {
      sendError(res, req, 402, 'insufficient_credits', 'not enough credits', {
        required_credits: cost.credits,
        available_credits: account.available_credits,
      });
      return false;
    }

    const reservationId = crypto.randomUUID();
    account.available_credits -= cost.credits;
    account.reserved_credits += cost.credits;
    appendLedger(state, user.id, 'reserve', -cost.credits, account, {
      jobId: reservationId,
      note: `quality=${cost.quality}`,
    });
    writeCreditsState(state);

    return {
      id: reservationId,
      userId: user.id,
      quality: cost.quality,
      credits: cost.credits,
    };
  });
}

function settleCredits(reservation) {
  if (!reservation || !CREDITS_ENABLED) return Promise.resolve(null);
  return withCreditsLock(() => {
    const state = readCreditsState();
    const account = getAccount(state, reservation.userId);
    if (!account) return null;
    account.reserved_credits = Math.max(0, account.reserved_credits - reservation.credits);
    appendLedger(state, reservation.userId, 'settle', -reservation.credits, account, {
      jobId: reservation.id,
      note: `quality=${reservation.quality}`,
    });
    writeCreditsState(state);
    return serializeWallet(state, reservation.userId);
  });
}

function releaseCredits(reservation, note = 'generation failed') {
  if (!reservation || !CREDITS_ENABLED) return Promise.resolve(null);
  return withCreditsLock(() => {
    const state = readCreditsState();
    const account = getAccount(state, reservation.userId);
    if (!account) return null;
    account.reserved_credits = Math.max(0, account.reserved_credits - reservation.credits);
    account.available_credits += reservation.credits;
    appendLedger(state, reservation.userId, 'release', reservation.credits, account, {
      jobId: reservation.id,
      note,
    });
    writeCreditsState(state);
    return serializeWallet(state, reservation.userId);
  });
}

function mapSizeToAspectRatio(size) {
  if (size === '1024x1536') return '2:3';
  if (size === '1536x1024') return '3:2';
  if (size === '1920x1080' || size === '2560x1440' || size === '3840x2160') return '16:9';
  return '1:1';
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
  const creditState = readCreditsState();
  const accounts = creditState.accounts || [];
  const codes = creditState.redemption_codes || [];

  return {
    config: {
      provider: IMAGE_PROVIDER,
      image_storage_provider: IMAGE_STORAGE_PROVIDER,
      credits_enabled: CREDITS_ENABLED,
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
  };
}

// ── 中间件 ──────────────────────────────────────────────
app.set('trust proxy', 1);
app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  res.setHeader('x-request-id', req.requestId);
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

// ── 健康检查 ────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({
    status: missingEnv.length > 0 ? 'degraded' : 'ok',
    mode: ENABLE_LOCAL_STORAGE ? 'local-storage' : 'serverless-proxy',
    provider: IMAGE_PROVIDER,
    image_storage_provider: IMAGE_STORAGE_PROVIDER,
    credits_enabled: CREDITS_ENABLED,
    has_required_env: missingEnv.length === 0,
    has_bypass_secret: IMAGE_API_BYPASS_SECRET.length > 0,
  });
});

app.get('/api/admin/overview', requireAdminAuth, (req, res) => {
  return sendOk(res, req, buildAdminOverview());
});

app.post('/api/redeem', async (req, res) => {
  if (!CREDITS_ENABLED) {
    return sendError(res, req, 404, 'credits_disabled', 'credits are not enabled');
  }

  const code = req.body && typeof req.body.code === 'string' ? req.body.code.trim() : '';
  if (!code) {
    return sendError(res, req, 400, 'invalid_code', 'redemption code is required');
  }

  return withCreditsLock(() => {
    const state = readCreditsState();
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

    const account = getAccount(state, user.id);
    account.available_credits += redemptionCode.credits;
    account.updated_at = new Date().toISOString();
    redemptionCode.status = 'redeemed';
    redemptionCode.redeemed_by_user_id = user.id;
    redemptionCode.redeemed_at = new Date().toISOString();
    appendLedger(state, user.id, 'redeem', redemptionCode.credits, account, {
      redemptionCodeId: redemptionCode.id,
    });
    writeCreditsState(state);

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
  const state = readCreditsState();
  const user = findUserByToken(state, userToken);
  if (!user) {
    return sendError(res, req, 401, 'wallet_required', 'wallet not found');
  }
  return sendOk(res, req, serializeWallet(state, user.id));
});

app.get('/api/jobs/:id', requireAuth, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return sendError(res, req, 404, 'job_not_found', 'job not found');
  }
  return sendOk(res, req, serializeJob(job));
});

// ── 核心：生图接口 ──────────────────────────────────────
app.post('/api/generate', generateRateLimiter, requireAuth, async (req, res) => {
  const start = Date.now();
  const { prompt, size = '1024x1024', n = 1, quality = 'auto' } = req.body || {};

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
            prompt: normalizedPrompt,
            aspect_ratio: mapSizeToAspectRatio(size),
            number_of_images: n,
            quality: process.env.REPLICATE_QUALITY || 'auto',
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
        return sendError(res, req, 502, 'upstream_failed', 'unable to create replicate prediction');
      }

      const jobId = crypto.randomUUID();
      const job = {
        id: jobId,
        provider: 'replicate',
        predictionId: prediction.id,
        getUrl: prediction.urls && prediction.urls.get ? prediction.urls.get : `https://api.replicate.com/v1/predictions/${prediction.id}`,
        status: prediction.status || 'starting',
        prompt: normalizedPrompt,
        size,
        outputFormat,
        creditReservation,
        requestId: req.requestId,
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
        status: job.status,
        size,
        model,
      });

      return sendOk(res, req, serializeJob(job), 202);
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

app.use('/api', (req, res) => {
  return sendError(res, req, 404, 'not_found', 'api endpoint not found');
});

// ── 启动 ────────────────────────────────────────────────
restoreStoredJobs();

if (require.main === module) {
  app.listen(PORT, () => console.log(`Image Studio running -> http://localhost:${PORT}`));
}

module.exports = app;
