import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

export const pluginRoot = path.resolve(currentDir, '../..');
export const sandboxRoot = path.join(pluginRoot, 'fixtures/sandbox');

export function loadVersionLock() {
  const lockPath = path.join(pluginRoot, 'fixtures/versions.lock');
  return YAML.parse(fs.readFileSync(lockPath, 'utf8'));
}
