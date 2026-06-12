#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from './lib/command.mjs';
import { loadVersionLock } from './lib/version-lock.mjs';

export function parseRemoteRefs(stdout) {
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [ref, name] = line.split(/\s+/);
      return { ref, name };
    });
}

export function isLockedTagReachable(stdout, source) {
  const exactTag = `refs/tags/${source.tag}`;
  const peeledTag = `${exactTag}^{}`;
  const refs = parseRemoteRefs(stdout);
  const tagRef = refs.find((item) => item.name === exactTag);
  const peeledRef = refs.find((item) => item.name === peeledTag);

  if (peeledRef) {
    return peeledRef.ref === source.ref;
  }

  return tagRef?.ref === source.ref;
}

export function checkSource(name, source) {
  const args = ['ls-remote', '--tags', source.repo, `refs/tags/${source.tag}`, `refs/tags/${source.tag}^{}`];
  const result = runCommand('git', args);
  const reachable = result.status === 0 && isLockedTagReachable(result.stdout, source);

  return {
    name,
    repo: source.repo,
    tag: source.tag,
    lockedRef: source.ref,
    command: `${result.command} ${args.join(' ')}`,
    reachable,
    status: result.status,
    stderr: result.stderr,
  };
}

export function checkUpstream() {
  const lock = loadVersionLock();
  const checks = [
    checkSource('ruoyiVuePlus', lock.ruoyiVuePlus),
    checkSource('plusUi', lock.plusUi),
  ];

  return {
    ok: checks.every((check) => check.reachable),
    checks,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const output = checkUpstream();

  console.log(JSON.stringify(output, null, 2));
  process.exit(output.ok ? 0 : 1);
}
