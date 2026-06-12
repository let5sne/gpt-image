import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadVersionLock, sandboxRoot } from '../scripts/lib/version-lock.mjs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(testsDir, '..');
const initSandboxCliPath = path.join(pluginRoot, 'scripts/init-sandbox.mjs');

function runInitSandboxCli(args) {
  return spawnSync(process.execPath, [initSandboxCliPath, ...args], {
    cwd: pluginRoot,
    encoding: 'utf8',
  });
}

test('version lock pins upstream commits and Java runtime', () => {
  const lock = loadVersionLock();

  assert.equal(lock.ruoyiVuePlus.ref, '6bfdcae06eaf218c4204382de277499be6c88c1b');
  assert.equal(lock.plusUi.ref, '9fd2b6f137298ad3511ffd1816bea60d69c795ce');
  assert.equal(lock.java.version, '17');
});

test('init-sandbox dry-run reports pinned sandbox targets', () => {
  const result = runInitSandboxCli(['--dry-run']);
  const output = JSON.parse(result.stdout);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(output.ok, true);
  assert.equal(output.backend.dryRun, true);
  assert.equal(output.backend.target, path.join(sandboxRoot, 'backend'));
  assert.equal(output.backend.ref, '6bfdcae06eaf218c4204382de277499be6c88c1b');
  assert.equal(output.frontend.dryRun, true);
  assert.equal(output.frontend.target, path.join(sandboxRoot, 'frontend'));
  assert.equal(output.frontend.ref, '9fd2b6f137298ad3511ffd1816bea60d69c795ce');
});
