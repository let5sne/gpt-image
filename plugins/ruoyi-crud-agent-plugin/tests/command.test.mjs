import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCommand } from '../scripts/lib/command.mjs';

test('runCommand captures output larger than Node default spawnSync buffer', () => {
  const bytes = 1024 * 1024 + 1;
  const result = runCommand(process.execPath, [
    '-e',
    `process.stdout.write('x'.repeat(${bytes}))`,
  ]);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.length, bytes);
});
