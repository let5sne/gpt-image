#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function main() {
  const root = process.cwd();
  const storageDir = process.env.STORAGE_DIR || path.join(root, 'storage');
  const creditsFile = process.env.CREDITS_FILE || path.join(storageDir, 'credits.json');
  const jobsFile = path.join(storageDir, 'jobs.json');
  const metadataFile = path.join(storageDir, 'metadata.json');
  const auditFile = process.env.ADMIN_AUDIT_LOG_FILE || path.join(storageDir, 'admin-audit.log');
  const outDir = path.join(root, 'db', 'seed');

  const credits = readJson(creditsFile, {});
  const jobs = readJson(jobsFile, []);
  const metadata = readJson(metadataFile, []);
  const audits = fs.existsSync(auditFile)
    ? fs.readFileSync(auditFile, 'utf-8').split('\n').filter(Boolean).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean)
    : [];

  const payload = {
    exported_at: new Date().toISOString(),
    source: {
      credits_file: creditsFile,
      jobs_file: jobsFile,
      metadata_file: metadataFile,
      audit_file: auditFile,
    },
    users: ensureArray(credits.users),
    wallets: ensureArray(credits.accounts),
    credit_ledger: ensureArray(credits.credit_ledger),
    redemption_batches: ensureArray(credits.redemption_batches),
    redemption_codes: ensureArray(credits.redemption_codes),
    generation_jobs: ensureArray(jobs),
    gallery_metadata: ensureArray(metadata),
    admin_audit_logs: audits,
  };

  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'bootstrap.json');
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), 'utf-8');

  const summary = {
    users: payload.users.length,
    wallets: payload.wallets.length,
    ledger: payload.credit_ledger.length,
    batches: payload.redemption_batches.length,
    codes: payload.redemption_codes.length,
    jobs: payload.generation_jobs.length,
    audits: payload.admin_audit_logs.length,
  };

  console.log(JSON.stringify({ ok: true, out_file: outFile, summary }, null, 2));
}

main();
