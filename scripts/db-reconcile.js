#!/usr/bin/env node
'use strict';

// M2 对账工具:比对「文件主存储(credits.json)」与「双写目标 DB」是否一致。
// 进入 Phase 3(读切换)前的验收闸门。只读,不写任何一侧。
// 用法: DATABASE_URL=... node scripts/db-reconcile.js   (或 npm run db:reconcile)

const fs = require('node:fs');
const path = require('node:path');

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}

// 从文件侧聚合出与 DB 可比对的指标
function fileMetrics(credits) {
  const wallets = arr(credits.accounts);
  const codes = arr(credits.redemption_codes);
  const keys = arr(credits.api_keys);
  return {
    users: arr(credits.users).length,
    wallets: wallets.length,
    available_sum: wallets.reduce((s, w) => s + (w.available_credits || 0), 0),
    reserved_sum: wallets.reduce((s, w) => s + (w.reserved_credits || 0), 0),
    ledger: arr(credits.credit_ledger).length,
    batches: arr(credits.redemption_batches).length,
    codes: codes.length,
    redeemed: codes.filter((c) => c.status === 'redeemed').length,
    revoked: codes.filter((c) => c.status === 'revoked').length,
    api_customers: arr(credits.api_customers).length,
    api_keys: keys.length,
    api_keys_active: keys.filter((k) => k.status === 'active').length,
  };
}

// 从 DB 聚合出同名指标
async function dbMetrics(pool) {
  const q = async (sql) => (await pool.query(sql)).rows[0];
  const u = await q('select count(*)::int n from users');
  const w = await q(
    'select count(*)::int n, coalesce(sum(available_credits),0)::int a, coalesce(sum(reserved_credits),0)::int r from wallets'
  );
  const l = await q('select count(*)::int n from credit_ledger');
  const b = await q('select count(*)::int n from redemption_batches');
  const c = await q(
    "select count(*)::int n, count(*) filter (where status='redeemed')::int redeemed, count(*) filter (where status='revoked')::int revoked from redemption_codes"
  );
  const ac = await q('select count(*)::int n from api_customers');
  const ak = await q(
    "select count(*)::int n, count(*) filter (where status='active')::int active from api_keys"
  );
  return {
    users: u.n,
    wallets: w.n,
    available_sum: w.a,
    reserved_sum: w.r,
    ledger: l.n,
    batches: b.n,
    codes: c.n,
    redeemed: c.redeemed,
    revoked: c.revoked,
    api_customers: ac.n,
    api_keys: ak.n,
    api_keys_active: ak.active,
  };
}
async function main() {
  const databaseUrl = (process.env.DATABASE_URL || '').trim();
  if (!databaseUrl) {
    console.error('DATABASE_URL 未设置,无法对账');
    process.exit(2);
  }
  const storageDir = process.env.STORAGE_DIR || path.join(process.cwd(), 'storage');
  const creditsFile = process.env.CREDITS_FILE || path.join(storageDir, 'credits.json');
  const credits = readJson(creditsFile, {});

  // pg 是 M2 可选依赖
  // eslint-disable-next-line global-require
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });

  let file;
  let db;
  try {
    file = fileMetrics(credits);
    db = await dbMetrics(pool);
  } finally {
    await pool.end();
  }

  const keys = Object.keys(file);
  const rows = keys.map((k) => ({ metric: k, file: file[k], db: db[k], match: file[k] === db[k] }));
  const mismatches = rows.filter((r) => !r.match);

  for (const r of rows) {
    console.log(`  ${r.match ? '✓' : '✗'} ${r.metric.padEnd(14)} file=${r.file}  db=${r.db}`);
  }
  if (mismatches.length === 0) {
    console.log(`\nRECONCILE PASS — 全部 ${rows.length} 项一致`);
    process.exit(0);
  } else {
    console.error(`\nRECONCILE FAIL — ${mismatches.length}/${rows.length} 项不一致: ${mismatches.map((m) => m.metric).join(', ')}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('reconcile 异常:', err.message);
  process.exit(2);
});
