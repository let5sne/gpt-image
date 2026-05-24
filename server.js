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
const AUTH_TOKEN = process.env.APP_ACCESS_TOKEN || '';
const AUTH_REQUIRED = process.env.AUTH_REQUIRED === 'true' || IS_VERCEL;

const REQUIRED_ENV = ['IMAGE_API_BASE', 'IMAGE_API_KEY'];
if (AUTH_REQUIRED) {
  REQUIRED_ENV.push('APP_ACCESS_TOKEN');
}
const missingEnv = REQUIRED_ENV.filter((name) => !process.env[name]);

const ALLOWED_SIZES = new Set([
  '1024x1024',
  '1024x1536',
  '1536x1024',
  '1920x1080',
  '2560x1440',
  '3840x2160',
  'auto',
]);
const MAX_PROMPT_CHARS = Number(process.env.MAX_PROMPT_CHARS || 800);
const MAX_IMAGES_PER_REQUEST = Number(process.env.MAX_IMAGES_PER_REQUEST || 1);
const MAX_PIXEL_COUNT = Number(process.env.MAX_PIXEL_COUNT || 5530000); // ~2K
const DAILY_LIMIT_PER_CLIENT = Number(process.env.DAILY_LIMIT_PER_CLIENT || 40);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60 * 1000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 12);
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 30000);

const dailyUsage = new Map();
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
const STORAGE_DIR = path.join(__dirname, 'storage');
const META_FILE = path.join(STORAGE_DIR, 'metadata.json');

if (ENABLE_LOCAL_STORAGE) {
  if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR);
  if (!fs.existsSync(META_FILE)) fs.writeFileSync(META_FILE, '[]', 'utf-8');
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

function readTokenFromRequest(req) {
  const headerToken = req.headers['x-app-token'];
  if (headerToken && typeof headerToken === 'string') return headerToken;
  const auth = req.headers.authorization;
  if (!auth || typeof auth !== 'string') return '';
  if (!auth.toLowerCase().startsWith('bearer ')) return '';
  return auth.slice(7).trim();
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

// ── 中间件 ──────────────────────────────────────────────
app.set('trust proxy', 1);
app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  res.setHeader('x-request-id', req.requestId);
  next();
});
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
if (ENABLE_LOCAL_STORAGE) {
  app.use('/storage', express.static(STORAGE_DIR));
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
    has_required_env: missingEnv.length === 0,
  });
});

// ── 核心：生图接口 ──────────────────────────────────────
app.post('/api/generate', generateRateLimiter, requireAuth, async (req, res) => {
  const start = Date.now();
  const { prompt, size = '1024x1024', n = 1 } = req.body || {};

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

  if (!ensureDailyQuota(req)) {
    return sendError(res, req, 429, 'quota_exceeded', 'daily generation quota exceeded');
  }

  if (missingEnv.length > 0) {
    log('error', 'config_error_missing_env', {
      request_id: req.requestId,
      missing_env: missingEnv,
    });
    return sendError(res, req, 500, 'service_unavailable', 'service unavailable');
  }

  let timeout = null;
  try {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

    const upstream = await fetch(
      `${process.env.IMAGE_API_BASE}/v1/images/generations`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.IMAGE_API_KEY}`,
        },
        body: JSON.stringify({
          model: process.env.IMAGE_API_MODEL || 'gpt-image-2',
          prompt: normalizedPrompt,
          size,
          n,
          response_format: ENABLE_LOCAL_STORAGE ? 'b64_json' : 'url',
        }),
      }
    );

    if (!upstream.ok) {
      const err = await upstream.text();
      log('error', 'upstream_error', {
        request_id: req.requestId,
        status: upstream.status,
        body: err.slice(0, 500),
      });
      return sendError(res, req, 502, 'upstream_failed', 'unable to generate image');
    }

    const json = await upstream.json();
    const took_ms = Date.now() - start;
    const model = process.env.IMAGE_API_MODEL || 'gpt-image-2';
    const meta = readMeta();
    const images = [];

    for (const d of (json.data || [])) {
      let localPath = null;
      let localUrl = null;
      let id = null;

      if (ENABLE_LOCAL_STORAGE) {
        id = crypto.randomUUID();
        const filename = `${id}.png`;
        localPath = path.join(STORAGE_DIR, filename);
        localUrl = `/storage/${filename}`;

        // 保存图片到本地
        try {
          if (d.b64_json) {
            fs.writeFileSync(localPath, Buffer.from(d.b64_json, 'base64'));
          } else if (d.url) {
            // 上游未返回 b64，降级为 URL 下载
            const imgRes = await fetch(d.url);
            if (!imgRes.ok) throw new Error(`download ${imgRes.status}`);
            const arrayBuf = await imgRes.arrayBuffer();
            fs.writeFileSync(localPath, Buffer.from(arrayBuf));
          } else {
            throw new Error('upstream returned no image data');
          }
        } catch (saveErr) {
          console.error('[save error]', saveErr.message);
        }
      }

      const saved = ENABLE_LOCAL_STORAGE && localPath && fs.existsSync(localPath);
      if (ENABLE_LOCAL_STORAGE) {
        const record = {
          id,
          prompt: normalizedPrompt,
          size,
          model,
          took_ms,
          local_url: saved ? localUrl : null,
          remote_url: d.url || null,
          created_at: new Date().toISOString(),
        };
        meta.push(record);
      }

      images.push({
        url: saved ? localUrl : (d.url || null),
        b64_json: null,
        local_url: ENABLE_LOCAL_STORAGE && saved ? localUrl : null,
        prompt: normalizedPrompt,
      });
    }

    if (ENABLE_LOCAL_STORAGE) {
      writeMeta(meta);
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
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      log('error', 'upstream_timeout', {
        request_id: req.requestId,
        timeout_ms: UPSTREAM_TIMEOUT_MS,
      });
      return sendError(res, req, 504, 'upstream_timeout', 'upstream request timed out');
    }
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

// ── 启动 ────────────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, () => console.log(`Image Studio running -> http://localhost:${PORT}`));
}

module.exports = app;
