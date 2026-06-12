#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { runCommand } from './lib/command.mjs';
import { loadVersionLock, sandboxRoot } from './lib/version-lock.mjs';

const dryRun = process.argv.includes('--dry-run');

function commandSummary(result, args) {
  return {
    command: `${result.command} ${args.join(' ')}`,
    cwd: result.cwd,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function clonePinned(name, source, target) {
  if (fs.existsSync(target)) {
    return {
      ok: true,
      name,
      target,
      skipped: true,
    };
  }

  if (dryRun) {
    return {
      ok: true,
      name,
      target,
      dryRun: true,
      repo: source.repo,
      tag: source.tag,
      ref: source.ref,
    };
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });

  const cloneArgs = ['clone', '--depth', '1', '--branch', source.tag, source.repo, target];
  const clone = runCommand('git', cloneArgs);
  if (clone.status !== 0) {
    return {
      ok: false,
      name,
      target,
      repo: source.repo,
      tag: source.tag,
      ref: source.ref,
      step: 'clone',
      ...commandSummary(clone, cloneArgs),
    };
  }

  const checkoutArgs = ['checkout', source.ref];
  const checkout = runCommand('git', checkoutArgs, { cwd: target });
  if (checkout.status !== 0) {
    return {
      ok: false,
      name,
      target,
      repo: source.repo,
      tag: source.tag,
      ref: source.ref,
      step: 'checkout',
      ...commandSummary(checkout, checkoutArgs),
    };
  }

  return {
    ok: true,
    name,
    target,
    repo: source.repo,
    tag: source.tag,
    ref: source.ref,
  };
}

const lock = loadVersionLock();
const backend = clonePinned('backend', lock.ruoyiVuePlus, path.join(sandboxRoot, 'backend'));
const frontend = clonePinned('frontend', lock.plusUi, path.join(sandboxRoot, 'frontend'));
const output = {
  ok: backend.ok && frontend.ok,
  backend,
  frontend,
};

console.log(JSON.stringify(output, null, 2));
process.exit(output.ok ? 0 : 1);
