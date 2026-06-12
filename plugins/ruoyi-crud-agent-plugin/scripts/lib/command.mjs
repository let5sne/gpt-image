import { spawnSync } from 'node:child_process';

export function runCommand(command, args, options = {}) {
  const cwd = options.cwd || process.cwd();
  const result = spawnSync(command, args, {
    ...options,
    shell: false,
    encoding: 'utf8',
  });

  if (result.error) {
    return {
      command,
      cwd,
      status: 127,
      stdout: result.stdout || '',
      stderr: result.error.message,
    };
  }

  return {
    command,
    cwd,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}
