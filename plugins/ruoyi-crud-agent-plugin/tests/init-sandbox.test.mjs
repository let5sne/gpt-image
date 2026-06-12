import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isLockedTagReachable } from '../scripts/check-upstream.mjs';
import { inspectExistingCheckout } from '../scripts/init-sandbox.mjs';
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

test('version lock pins upstream repositories, versions, and tooling', () => {
  const lock = loadVersionLock();

  assert.equal(lock.ruoyiVuePlus.repo, 'https://github.com/dromara/RuoYi-Vue-Plus.git');
  assert.equal(lock.ruoyiVuePlus.tag, 'v5.6.1');
  assert.equal(lock.ruoyiVuePlus.ref, '6bfdcae06eaf218c4204382de277499be6c88c1b');
  assert.equal(lock.plusUi.repo, 'https://github.com/CrazyLionCat/plus-ui.git');
  assert.equal(lock.plusUi.tag, 'v5.6.1-v2.6.1');
  assert.equal(lock.plusUi.ref, '9fd2b6f137298ad3511ffd1816bea60d69c795ce');
  assert.equal(lock.java.version, '17');
  assert.equal(lock.node.version, '>=20.19.0');
  assert.equal(lock.packageManager.frontend, 'pnpm');
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

test('existing sandbox target must be a checkout at the locked ref', () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'ruoyi-sandbox-invalid-'));
  const source = {
    ref: '6bfdcae06eaf218c4204382de277499be6c88c1b',
  };
  const result = inspectExistingCheckout('backend', source, target);

  assert.equal(result.ok, false);
  assert.equal(result.code, 'sandbox_invalid_checkout');
  assert.equal(result.name, 'backend');
  assert.equal(result.target, target);
  assert.equal(result.expectedRef, source.ref);
  assert.equal(Object.hasOwn(result, 'actualRef'), false);
});

test('ls-remote parser requires exact annotated tag peeled commit', () => {
  const source = {
    tag: 'v5.6.1',
    ref: '6bfdcae06eaf218c4204382de277499be6c88c1b',
  };
  const stdout = [
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/tags/v5.6.10',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/tags/v5.6.10^{}',
    'fda405dc0136ddeb48376b6ed8b83ed71a7a425e\trefs/tags/v5.6.1',
    '6bfdcae06eaf218c4204382de277499be6c88c1b\trefs/tags/v5.6.1^{}',
  ].join('\n');

  assert.equal(isLockedTagReachable(stdout, source), true);
});

test('ls-remote parser accepts exact lightweight tag commit', () => {
  const source = {
    tag: 'v1.0.0',
    ref: '1111111111111111111111111111111111111111',
  };
  const stdout = '1111111111111111111111111111111111111111\trefs/tags/v1.0.0\n';

  assert.equal(isLockedTagReachable(stdout, source), true);
});

test('ls-remote parser rejects annotated tag object without matching peeled commit', () => {
  const source = {
    tag: 'v1.0.0',
    ref: '2222222222222222222222222222222222222222',
  };
  const stdout = [
    '2222222222222222222222222222222222222222\trefs/tags/v1.0.0',
    '3333333333333333333333333333333333333333\trefs/tags/v1.0.0^{}',
  ].join('\n');

  assert.equal(isLockedTagReachable(stdout, source), false);
});
