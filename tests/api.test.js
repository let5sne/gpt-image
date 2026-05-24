const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

function loadFreshApp() {
  const modulePath = require.resolve('../server');
  delete require.cache[modulePath];
  return require('../server');
}

function setBaseEnv() {
  process.env.IMAGE_API_BASE = 'https://example.com';
  process.env.IMAGE_API_KEY = 'test-key';
  process.env.IMAGE_API_MODEL = 'gpt-image-2';
  process.env.AUTH_REQUIRED = 'false';
  delete process.env.APP_ACCESS_TOKEN;
  delete process.env.VERCEL;
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
