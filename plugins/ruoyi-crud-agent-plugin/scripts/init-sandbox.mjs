#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from './lib/command.mjs';
import { loadVersionLock, sandboxRoot } from './lib/version-lock.mjs';

function commandSummary(result, args) {
  return {
    command: `${result.command} ${args.join(' ')}`,
    cwd: result.cwd,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function inspectExistingCheckout(name, source, target) {
  const args = ['rev-parse', '--verify', 'HEAD'];
  const result = runCommand('git', args, { cwd: target });

  if (result.status !== 0) {
    return {
      ok: false,
      code: 'sandbox_invalid_checkout',
      name,
      target,
      expectedRef: source.ref,
    };
  }

  const actualRef = result.stdout.trim();
  if (actualRef !== source.ref) {
    return {
      ok: false,
      code: 'sandbox_invalid_checkout',
      name,
      target,
      expectedRef: source.ref,
      actualRef,
    };
  }

  return {
    ok: true,
    name,
    target,
    skipped: true,
    actualRef,
  };
}

export function clonePinned(name, source, target, options = {}) {
  if (fs.existsSync(target)) {
    return inspectExistingCheckout(name, source, target);
  }

  if (options.dryRun) {
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

export function initSandbox(options = {}) {
  const lock = loadVersionLock();
  const backend = clonePinned('backend', lock.ruoyiVuePlus, path.join(sandboxRoot, 'backend'), options);
  const frontend = clonePinned('frontend', lock.plusUi, path.join(sandboxRoot, 'frontend'), options);

  return {
    ok: backend.ok && frontend.ok,
    backend,
    frontend,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const output = initSandbox({ dryRun: process.argv.includes('--dry-run') });

  console.log(JSON.stringify(output, null, 2));
  process.exit(output.ok ? 0 : 1);
}
