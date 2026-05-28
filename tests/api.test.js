const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function waitFor(check, timeoutMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for condition');
}

function loadFreshApp() {
  const modulePath = require.resolve('../server');
  delete require.cache[modulePath];
  return require('../server');
}

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-image-test-'));
}

function hashWithPepper(value, pepper = 'test-pepper') {
  return crypto.createHash('sha256').update(`${pepper}:${value}`).digest('hex');
}

function seedCreditsFile(file, { code = 'TEST-CODE-100', credits = 100 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    users: [],
    accounts: [],
    credit_ledger: [],
    redemption_batches: [{
      id: 'batch-test',
      name: 'test batch',
      credits_per_code: credits,
      code_count: 1,
      expires_at: null,
      created_at: new Date().toISOString(),
    }],
    redemption_codes: [{
      id: 'code-test',
      batch_id: 'batch-test',
      code_hash: hashWithPepper(code),
      credits,
      status: 'active',
      redeemed_by_user_id: null,
      redeemed_at: null,
      expires_at: null,
      created_at: new Date().toISOString(),
    }],
  }, null, 2), 'utf-8');
}

function setBaseEnv() {
  process.env.IMAGE_API_BASE = 'https://example.com';
  process.env.IMAGE_API_KEY = 'test-key';
  process.env.IMAGE_API_MODEL = 'gpt-image-2';
  process.env.IMAGE_PROVIDER = 'openai';
  process.env.AUTH_REQUIRED = 'false';
  process.env.CREDITS_ENABLED = 'false';
  process.env.STORAGE_DIR = path.join(createTempDir(), 'storage');
  delete process.env.IMAGE_API_BYPASS_SECRET;
  delete process.env.REPLICATE_API_TOKEN;
  delete process.env.REPLICATE_MODEL;
  delete process.env.REPLICATE_POLL_INTERVAL_MS;
  delete process.env.REPLICATE_MAX_POLL_MS;
  delete process.env.CREDITS_FILE;
  delete process.env.CREDIT_CODE_PEPPER;
  delete process.env.CREDIT_COST_REPLICATE_GPT_IMAGE_2_LOW;
  delete process.env.CREDIT_COST_REPLICATE_GPT_IMAGE_2_MEDIUM;
  delete process.env.CREDIT_COST_REPLICATE_GPT_IMAGE_2_AUTO;
  delete process.env.CREDIT_COST_REPLICATE_GPT_IMAGE_2_HIGH;
  delete process.env.IMAGE_STORAGE_PROVIDER;
  delete process.env.IMAGE_STORAGE_PUBLIC_BASE_URL;
  delete process.env.IMAGE_STORAGE_PREFIX;
  delete process.env.IMAGE_STORAGE_UPLOAD_TIMEOUT_MS;
  delete process.env.S3_ENDPOINT;
  delete process.env.S3_BUCKET;
  delete process.env.S3_REGION;
  delete process.env.S3_ACCESS_KEY_ID;
  delete process.env.S3_SECRET_ACCESS_KEY;
  delete process.env.S3_FORCE_PATH_STYLE;
  delete process.env.ADMIN_TOKEN;
  delete process.env.APP_ACCESS_TOKEN;
  delete process.env.VERCEL;
  delete process.env.OPENROUTER_IMAGE_API_BASE;
  delete process.env.OPENROUTER_IMAGE_API_KEY;
  delete process.env.OPENROUTER_IMAGE_API_MODEL;
  delete process.env.OPENROUTER_IMAGE_API_BYPASS_SECRET;
}

function enableCredits(file) {
  process.env.CREDITS_ENABLED = 'true';
  process.env.CREDITS_FILE = file;
  process.env.CREDIT_CODE_PEPPER = 'test-pepper';
}

test('GET /api/health returns mode and env status', async () => {
  setBaseEnv();
  const app = loadFreshApp();

  const res = await request(app).get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.status, 'string');
  assert.equal(typeof res.body.mode, 'string');
  assert.equal(typeof res.body.has_required_env, 'boolean');
});

test('POST /api/generate rejects empty prompt', async () => {
  setBaseEnv();
  const app = loadFreshApp();

  const res = await request(app)
    .post('/api/generate')
    .send({ prompt: '   ', size: '1024x1024' });

  assert.equal(res.status, 400);
  assert.equal(res.body.success, false);
  assert.equal(res.body.error.code, 'invalid_prompt');
});

test('POST /api/generate rejects unsupported size before upstream call', async () => {
  setBaseEnv();
  const app = loadFreshApp();

  const res = await request(app)
    .post('/api/generate')
    .send({ prompt: 'a valid prompt', size: '9999x9999' });

  assert.equal(res.status, 400);
  assert.equal(res.body.success, false);
  assert.equal(res.body.error.code, 'invalid_size');
});

test('POST /api/generate requires token when auth is enabled', async () => {
  setBaseEnv();
  process.env.AUTH_REQUIRED = 'true';
  process.env.APP_ACCESS_TOKEN = 'token-123';

  const app = loadFreshApp();

  const res = await request(app)
    .post('/api/generate')
    .send({ prompt: 'a valid prompt', size: '1024x1024' });

  assert.equal(res.status, 401);
  assert.equal(res.body.success, false);
  assert.equal(res.body.error.code, 'unauthorized');
});

test('POST /api/generate returns JSON for malformed JSON body', async () => {
  setBaseEnv();
  const app = loadFreshApp();

  const res = await request(app)
    .post('/api/generate')
    .set('Content-Type', 'application/json')
    .send('{"prompt":');

  assert.equal(res.status, 400);
  assert.match(res.headers['content-type'], /application\/json/);
  assert.equal(res.body.success, false);
  assert.equal(res.body.error.code, 'invalid_json');
});

test('GET /api/unknown returns JSON envelope instead of HTML', async () => {
  setBaseEnv();
  const app = loadFreshApp();

  const res = await request(app).get('/api/unknown');

  assert.equal(res.status, 404);
  assert.match(res.headers['content-type'], /application\/json/);
  assert.equal(res.body.success, false);
  assert.equal(res.body.error.code, 'not_found');
});

test('POST /api/generate forwards internal bypass header when configured', async () => {
  setBaseEnv();
  process.env.IMAGE_API_BYPASS_SECRET = 'bypass-secret';
  let upstreamHeaders = null;
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => {
    upstreamHeaders = options.headers;
    return {
      ok: true,
      async json() {
        return { data: [] };
      },
    };
  };

  try {
    const app = loadFreshApp();
    const res = await request(app)
      .post('/api/generate')
      .send({ prompt: 'a valid prompt', size: '1024x1024' });

    assert.equal(res.status, 200);
    assert.equal(upstreamHeaders['X-Internal-Bypass'], 'bypass-secret');
  } finally {
    global.fetch = originalFetch;
  }
});

test('POST /api/generate resolves provider specific env when IMAGE_PROVIDER changes', async () => {
  setBaseEnv();
  process.env.IMAGE_PROVIDER = 'openrouter';
  process.env.OPENROUTER_IMAGE_API_BASE = 'https://openrouter.example.com';
  process.env.OPENROUTER_IMAGE_API_KEY = 'openrouter-key';
  process.env.OPENROUTER_IMAGE_API_MODEL = 'openai/gpt-image-2';
  process.env.OPENROUTER_IMAGE_API_BYPASS_SECRET = 'openrouter-bypass';

  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return {
      ok: true,
      status: 200,
      async json() {
        return { data: [] };
      },
    };
  };

  try {
    const app = loadFreshApp();
    const res = await request(app)
      .post('/api/generate')
      .send({ prompt: 'a valid prompt', size: '1024x1024' });

    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://openrouter.example.com/v1/images/generations');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer openrouter-key');
    assert.equal(calls[0].options.headers['X-Internal-Bypass'], 'openrouter-bypass');
    const upstreamBody = JSON.parse(calls[0].options.body);
    assert.equal(upstreamBody.model, 'openai/gpt-image-2');
  } finally {
    global.fetch = originalFetch;
  }
});

test('POST /api/generate creates async Replicate job when provider is replicate', async () => {
  setBaseEnv();
  process.env.IMAGE_PROVIDER = 'replicate';
  process.env.REPLICATE_API_TOKEN = 'replicate-token';
  process.env.REPLICATE_POLL_INTERVAL_MS = '1';
  process.env.REPLICATE_MAX_POLL_MS = '1000';

  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const urlText = String(url);
    calls.push({ url: urlText, options });

    if (urlText === 'https://api.replicate.com/v1/models/openai/gpt-image-2/predictions') {
      return {
        ok: true,
        status: 201,
        async json() {
          return {
            id: 'pred-123',
            status: 'starting',
            urls: { get: 'https://api.replicate.com/v1/predictions/pred-123' },
          };
        },
        async text() {
          return '';
        },
      };
    }

    if (urlText === 'https://api.replicate.com/v1/predictions/pred-123') {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            id: 'pred-123',
            status: 'succeeded',
            output: {
              image: 'https://replicate.delivery/pbxt/test-image.png',
              caption: 'not an image url',
            },
          };
        },
        async text() {
          return '';
        },
      };
    }

    if (urlText === 'https://replicate.delivery/pbxt/test-image.png') {
      return {
        ok: true,
        status: 200,
        async arrayBuffer() {
          return Buffer.from('png-bytes');
        },
      };
    }

    throw new Error(`unexpected fetch ${urlText}`);
  };

  try {
    const app = loadFreshApp();
    const created = await request(app)
      .post('/api/generate')
      .send({ prompt: 'a valid prompt', size: '1024x1024' });

    assert.equal(created.status, 202);
    assert.equal(created.body.success, true);
    assert.equal(created.body.data.status, 'starting');
    assert.equal(created.body.data.provider, 'replicate');
    assert.equal(typeof created.body.data.job_id, 'string');

    const createCall = calls.find((call) => call.url.includes('/models/openai/gpt-image-2/predictions'));
    assert.ok(createCall);
    assert.equal(createCall.options.headers.Authorization, 'Bearer replicate-token');
    const createBody = JSON.parse(createCall.options.body);
    assert.equal(createBody.input.prompt, 'a valid prompt');
    assert.equal(createBody.input.aspect_ratio, '1:1');
    assert.equal(createBody.input.number_of_images, 1);
    assert.equal(createBody.input.output_format, 'png');

    const jobId = created.body.data.job_id;
    const completed = await waitFor(async () => {
      const res = await request(app).get(`/api/jobs/${jobId}`);
      if (res.body.data && res.body.data.status === 'succeeded') return res;
      return null;
    });

    assert.equal(completed.status, 200);
    assert.equal(completed.body.data.prediction_id, 'pred-123');
    assert.equal(completed.body.data.images.length, 1);
    assert.match(completed.body.data.images[0].url, /^\/storage\//);

    const imageCall = calls.find((call) => call.url === 'https://replicate.delivery/pbxt/test-image.png');
    assert.ok(imageCall);
    assert.equal(imageCall.options.headers.Authorization, 'Bearer replicate-token');
  } finally {
    global.fetch = originalFetch;
  }
});

test('restores pending Replicate job from local storage and continues polling', async () => {
  setBaseEnv();
  process.env.IMAGE_PROVIDER = 'replicate';
  process.env.REPLICATE_API_TOKEN = 'replicate-token';
  process.env.REPLICATE_POLL_INTERVAL_MS = '1';
  process.env.REPLICATE_MAX_POLL_MS = '1000';

  const storageDir = process.env.STORAGE_DIR;
  fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(path.join(storageDir, 'jobs.json'), JSON.stringify([{
    id: 'restored-job',
    provider: 'replicate',
    predictionId: 'pred-restored',
    getUrl: 'https://api.replicate.com/v1/predictions/pred-restored',
    status: 'starting',
    prompt: 'restored prompt',
    size: '1024x1024',
    outputFormat: 'png',
    creditReservation: null,
    requestId: 'req-restored',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    prediction: { id: 'pred-restored', status: 'starting' },
    images: [],
  }], null, 2), 'utf-8');

  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const urlText = String(url);
    calls.push({ url: urlText, options });

    if (urlText === 'https://api.replicate.com/v1/predictions/pred-restored') {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            id: 'pred-restored',
            status: 'succeeded',
            output: ['https://replicate.delivery/pbxt/restored.png'],
          };
        },
      };
    }

    if (urlText === 'https://replicate.delivery/pbxt/restored.png') {
      return {
        ok: true,
        status: 200,
        async arrayBuffer() {
          return Buffer.from('restored-png');
        },
      };
    }

    throw new Error(`unexpected fetch ${urlText}`);
  };

  try {
    const app = loadFreshApp();
    const completed = await waitFor(async () => {
      const res = await request(app).get('/api/jobs/restored-job');
      if (res.body.data && res.body.data.status === 'succeeded') return res;
      return null;
    });

    assert.equal(completed.status, 200);
    assert.equal(completed.body.data.prediction_id, 'pred-restored');
    assert.equal(completed.body.data.images.length, 1);
    assert.match(completed.body.data.images[0].url, /^\/storage\//);
    assert.ok(calls.some((call) => call.url === 'https://api.replicate.com/v1/predictions/pred-restored'));
  } finally {
    global.fetch = originalFetch;
  }
});

test('POST /api/redeem creates user wallet and prevents duplicate redemption', async () => {
  setBaseEnv();
  const creditsFile = path.join(createTempDir(), 'credits.json');
  enableCredits(creditsFile);
  seedCreditsFile(creditsFile);
  const app = loadFreshApp();

  const redeemed = await request(app)
    .post('/api/redeem')
    .send({ code: 'TEST-CODE-100' });

  assert.equal(redeemed.status, 200);
  assert.equal(redeemed.body.success, true);
  assert.equal(redeemed.body.data.credits_added, 100);
  assert.equal(redeemed.body.data.available_credits, 100);
  assert.equal(redeemed.body.data.reserved_credits, 0);
  assert.equal(typeof redeemed.body.data.user_token, 'string');

  const wallet = await request(app)
    .get('/api/wallet')
    .set('x-user-token', redeemed.body.data.user_token);

  assert.equal(wallet.status, 200);
  assert.equal(wallet.body.data.available_credits, 100);
  assert.equal(wallet.body.data.reserved_credits, 0);
  assert.equal(wallet.body.data.recent_ledger[0].type, 'redeem');

  const duplicate = await request(app)
    .post('/api/redeem')
    .send({ code: 'TEST-CODE-100' });

  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.success, false);
  assert.equal(duplicate.body.error.code, 'code_already_redeemed');
});

test('POST /api/generate settles credits when generation succeeds', async () => {
  setBaseEnv();
  const creditsFile = path.join(createTempDir(), 'credits.json');
  enableCredits(creditsFile);
  seedCreditsFile(creditsFile);
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    async json() {
      return { data: [{ b64_json: Buffer.from('test-image').toString('base64') }] };
    },
  });

  try {
    const app = loadFreshApp();
    const redeemed = await request(app)
      .post('/api/redeem')
      .send({ code: 'TEST-CODE-100' });
    const userToken = redeemed.body.data.user_token;

    const generated = await request(app)
      .post('/api/generate')
      .set('x-user-token', userToken)
      .send({ prompt: 'a valid prompt', size: '1024x1024', quality: 'low' });

    assert.equal(generated.status, 200);
    assert.equal(generated.body.success, true);
    assert.equal(generated.body.data.charged_credits, 3);

    const wallet = await request(app)
      .get('/api/wallet')
      .set('x-user-token', userToken);

    assert.equal(wallet.body.data.available_credits, 97);
    assert.equal(wallet.body.data.reserved_credits, 0);
    assert.ok(wallet.body.data.recent_ledger.some((item) => item.type === 'settle'));
  } finally {
    global.fetch = originalFetch;
  }
});

test('POST /api/generate uploads generated image to S3-compatible storage when configured', async () => {
  setBaseEnv();
  process.env.IMAGE_STORAGE_PROVIDER = 's3';
  process.env.IMAGE_STORAGE_PUBLIC_BASE_URL = 'https://cdn.example.com/images';
  process.env.S3_ENDPOINT = 'https://r2.example.com';
  process.env.S3_BUCKET = 'image-bucket';
  process.env.S3_REGION = 'auto';
  process.env.S3_ACCESS_KEY_ID = 'access-key';
  process.env.S3_SECRET_ACCESS_KEY = 'secret-key';

  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const urlText = String(url);
    calls.push({ url: urlText, options });

    if (urlText === 'https://example.com/v1/images/generations') {
      return {
        ok: true,
        async json() {
          return { data: [{ b64_json: Buffer.from('s3-image').toString('base64') }] };
        },
      };
    }

    if (urlText.startsWith('https://r2.example.com/image-bucket/')) {
      return {
        ok: true,
        status: 200,
        async text() {
          return '';
        },
      };
    }

    throw new Error(`unexpected fetch ${urlText}`);
  };

  try {
    const app = loadFreshApp();
    const generated = await request(app)
      .post('/api/generate')
      .send({ prompt: 'a valid prompt', size: '1024x1024' });

    assert.equal(generated.status, 200);
    assert.equal(generated.body.success, true);
    assert.match(generated.body.data.images[0].url, /^https:\/\/cdn\.example\.com\/images\//);
    assert.equal(generated.body.data.images[0].local_url, null);

    const uploadCall = calls.find((call) => call.url.startsWith('https://r2.example.com/image-bucket/'));
    assert.ok(uploadCall);
    assert.equal(uploadCall.options.method, 'PUT');
    assert.equal(uploadCall.options.headers['Content-Type'], 'image/png');
    assert.match(uploadCall.options.headers.Authorization, /^AWS4-HMAC-SHA256 /);
    assert.deepEqual(Buffer.from(uploadCall.options.body), Buffer.from('s3-image'));
  } finally {
    global.fetch = originalFetch;
  }
});

test('POST /api/generate releases credits when S3 upload fails for b64-only image', async () => {
  setBaseEnv();
  const creditsFile = path.join(createTempDir(), 'credits.json');
  enableCredits(creditsFile);
  seedCreditsFile(creditsFile);
  process.env.IMAGE_STORAGE_PROVIDER = 's3';
  process.env.IMAGE_STORAGE_PUBLIC_BASE_URL = 'https://cdn.example.com/images';
  process.env.S3_ENDPOINT = 'https://r2.example.com';
  process.env.S3_BUCKET = 'image-bucket';
  process.env.S3_REGION = 'auto';
  process.env.S3_ACCESS_KEY_ID = 'access-key';
  process.env.S3_SECRET_ACCESS_KEY = 'secret-key';

  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const urlText = String(url);

    if (urlText === 'https://example.com/v1/images/generations') {
      return {
        ok: true,
        async json() {
          return { data: [{ b64_json: Buffer.from('s3-image').toString('base64') }] };
        },
      };
    }

    if (urlText.startsWith('https://r2.example.com/image-bucket/')) {
      return {
        ok: false,
        status: 500,
        async text() {
          return 'upload failed';
        },
      };
    }

    throw new Error(`unexpected fetch ${urlText}`);
  };

  try {
    const app = loadFreshApp();
    const redeemed = await request(app)
      .post('/api/redeem')
      .send({ code: 'TEST-CODE-100' });
    const userToken = redeemed.body.data.user_token;

    const generated = await request(app)
      .post('/api/generate')
      .set('x-user-token', userToken)
      .send({ prompt: 'a valid prompt', size: '1024x1024', quality: 'low' });

    assert.equal(generated.status, 500);
    assert.equal(generated.body.success, false);

    const wallet = await request(app)
      .get('/api/wallet')
      .set('x-user-token', userToken);

    assert.equal(wallet.body.data.available_credits, 100);
    assert.equal(wallet.body.data.reserved_credits, 0);
    assert.ok(wallet.body.data.recent_ledger.some((item) => item.type === 'release'));
  } finally {
    global.fetch = originalFetch;
  }
});

test('GET /api/admin/overview requires admin token and returns redacted operational stats', async () => {
  setBaseEnv();
  process.env.ADMIN_TOKEN = 'admin-secret';
  const creditsFile = path.join(createTempDir(), 'credits.json');
  enableCredits(creditsFile);
  seedCreditsFile(creditsFile);

  const storageDir = process.env.STORAGE_DIR;
  fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(path.join(storageDir, 'metadata.json'), JSON.stringify([{
    id: 'image-1',
    prompt: 'admin prompt',
    size: '1024x1024',
    model: 'gpt-image-2',
    took_ms: 123,
    local_url: '/storage/image-1.png',
    remote_url: '/storage/image-1.png',
    created_at: '2026-05-28T00:00:00.000Z',
  }], null, 2), 'utf-8');
  fs.writeFileSync(path.join(storageDir, 'jobs.json'), JSON.stringify([{
    id: 'job-1',
    predictionId: 'pred-1',
    status: 'succeeded',
    prompt: 'job prompt',
    size: '1024x1024',
    requestId: 'req-1',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    images: [],
  }], null, 2), 'utf-8');

  const app = loadFreshApp();

  const unauthorized = await request(app).get('/api/admin/overview');
  assert.equal(unauthorized.status, 401);

  const overview = await request(app)
    .get('/api/admin/overview')
    .set('x-admin-token', 'admin-secret');

  assert.equal(overview.status, 200);
  assert.equal(overview.body.success, true);
  assert.equal(overview.body.data.gallery.total, 1);
  assert.equal(overview.body.data.jobs.total, 1);
  assert.equal(overview.body.data.jobs.by_status.succeeded, 1);
  assert.equal(overview.body.data.credits.users, 0);
  assert.equal(overview.body.data.credits.codes.active, 1);
  assert.equal(overview.body.data.credits.codes.redeemed, 0);
  assert.equal(overview.body.data.config.provider, 'openai');
  assert.equal(overview.body.data.config.image_storage_provider, 'local');
  assert.deepEqual(Object.keys(overview.body.data.credits).includes('redemption_codes'), false);
  assert.equal(JSON.stringify(overview.body.data).includes('code_hash'), false);
  assert.equal(JSON.stringify(overview.body.data).includes('user_token_hash'), false);
});

test('POST /api/generate releases reserved credits when upstream fails', async () => {
  setBaseEnv();
  const creditsFile = path.join(createTempDir(), 'credits.json');
  enableCredits(creditsFile);
  seedCreditsFile(creditsFile);
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 502,
    headers: new Map(),
    async text() {
      return '{"error":"bad gateway"}';
    },
  });

  try {
    const app = loadFreshApp();
    const redeemed = await request(app)
      .post('/api/redeem')
      .send({ code: 'TEST-CODE-100' });
    const userToken = redeemed.body.data.user_token;

    const generated = await request(app)
      .post('/api/generate')
      .set('x-user-token', userToken)
      .send({ prompt: 'a valid prompt', size: '1024x1024', quality: 'low' });

    assert.equal(generated.status, 502);

    const wallet = await request(app)
      .get('/api/wallet')
      .set('x-user-token', userToken);

    assert.equal(wallet.body.data.available_credits, 100);
    assert.equal(wallet.body.data.reserved_credits, 0);
    assert.ok(wallet.body.data.recent_ledger.some((item) => item.type === 'release'));
  } finally {
    global.fetch = originalFetch;
  }
});
