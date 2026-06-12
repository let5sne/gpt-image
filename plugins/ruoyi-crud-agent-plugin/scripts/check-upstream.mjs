#!/usr/bin/env node
import { runCommand } from './lib/command.mjs';
import { loadVersionLock } from './lib/version-lock.mjs';

function parseRemoteRefs(stdout) {
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [ref, name] = line.split(/\s+/);
      return { ref, name };
    });
}

function checkSource(name, source) {
  const args = ['ls-remote', '--tags', source.repo, `refs/tags/${source.tag}*`];
  const result = runCommand('git', args);
  const refs = result.status === 0 ? parseRemoteRefs(result.stdout) : [];
  const reachable = refs.some((item) => item.ref === source.ref);

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

const lock = loadVersionLock();
const checks = [
  checkSource('ruoyiVuePlus', lock.ruoyiVuePlus),
  checkSource('plusUi', lock.plusUi),
];
const output = {
  ok: checks.every((check) => check.reachable),
  checks,
};

console.log(JSON.stringify(output, null, 2));
process.exit(output.ok ? 0 : 1);
