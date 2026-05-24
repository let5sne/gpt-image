require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_VERCEL = Boolean(process.env.VERCEL);
const REQUIRED_ENV = ['IMAGE_API_BASE', 'IMAGE_API_KEY'];
const missingEnv = REQUIRED_ENV.filter((name) => !process.env[name]);
const ENABLE_LOCAL_STORAGE = !IS_VERCEL;

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

// ── 中间件 ──────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
if (ENABLE_LOCAL_STORAGE) {
  app.use('/storage', express.static(STORAGE_DIR));
}

// ── 健康检查 ────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({
    status: missingEnv.length > 0 ? 'degraded' : 'ok',
    mode: ENABLE_LOCAL_STORAGE ? 'local-storage' : 'serverless-proxy',
    has_required_env: missingEnv.length === 0,
  });
});

// ── 核心：生图接口 ──────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  const start = Date.now();
  const { prompt, size = '1024x1024', n = 1 } = req.body;

  if (!prompt) return res.status(400).json({ error: 'prompt is required' });
  if (missingEnv.length > 0) {
    console.error('[config error] missing env:', missingEnv);
    return res.status(500).json({
      error: 'service unavailable',
    });
  }

  try {
    const upstream = await fetch(
      `${process.env.IMAGE_API_BASE}/v1/images/generations`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.IMAGE_API_KEY}`,
        },
        body: JSON.stringify({
          model: process.env.IMAGE_API_MODEL || 'gpt-image-2',
          prompt,
          size,
          n,
          response_format: ENABLE_LOCAL_STORAGE ? 'b64_json' : 'url',
        }),
      }
    );

    if (!upstream.ok) {
      const err = await upstream.text();
      console.error('[upstream error]', upstream.status, err);
      return res.status(502).json({ error: 'unable to generate image' });
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
          prompt,
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
        b64_json: null,            // 已存本地，不再返回 base64
        local_url: ENABLE_LOCAL_STORAGE && saved ? localUrl : null,
        prompt,
      });
    }

    if (ENABLE_LOCAL_STORAGE) {
      writeMeta(meta);
    }

    res.json({ images, took_ms, model, prompt });
  } catch (e) {
    console.error('[generate error]', e);
    res.status(500).json({ error: 'internal error', message: e.message });
  }
});

// ── 画廊接口：返回历史生成记录 ─────────────────────────
app.get('/api/gallery', (_req, res) => {
  if (!ENABLE_LOCAL_STORAGE) {
    return res.json([]);
  }
  const meta = readMeta();
  // 最新的排前面
  res.json(meta.slice().reverse());
});

// ── 启动 ────────────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, () => console.log(`Image Studio running -> http://localhost:${PORT}`));
}

module.exports = app;
