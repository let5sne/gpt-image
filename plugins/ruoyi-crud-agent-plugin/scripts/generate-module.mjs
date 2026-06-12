#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateBackendModule } from './lib/backend-generator.mjs';
import { generateFrontendModule } from './lib/frontend-generator.mjs';
import { loadAndValidateSpec, SpecInputError } from './lib/spec-loader.mjs';
import { sandboxRoot } from './lib/version-lock.mjs';

function printJson(stream, payload) {
  stream.write(`${JSON.stringify(payload, null, 2)}\n`);
}

export function generateModule(specPath, options = {}) {
  const result = loadAndValidateSpec(specPath);
  if (!result.valid) {
    return {
      ok: false,
      code: 'invalid_spec',
      errors: result.errors,
    };
  }

  const backendRoot = path.join(sandboxRoot, 'backend');
  const frontendRoot = path.join(sandboxRoot, 'frontend');
  const backend = generateBackendModule(result.spec, backendRoot, { force: options.force });
  const frontend = generateFrontendModule(result.spec, frontendRoot, { force: options.force });

  return {
    ok: backend.ok && frontend.ok,
    backend,
    frontend,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const specPath = process.argv.slice(2).find((arg) => arg !== '--force');
  const force = process.argv.includes('--force');

  if (!specPath) {
    printJson(process.stderr, {
      ok: false,
      code: 'invalid_args',
      message: 'spec path is required',
    });
    process.exit(2);
  }

  try {
    const output = generateModule(specPath, { force });
    if (output.code === 'invalid_spec') {
      printJson(process.stderr, output);
      process.exit(1);
    }
    printJson(process.stdout, output);
    process.exit(output.ok ? 0 : 1);
  } catch (error) {
    if (error instanceof SpecInputError) {
      printJson(process.stderr, {
        ok: false,
        code: error.code,
        message: error.message,
        errors: error.errors,
      });
      process.exit(1);
    }

    printJson(process.stderr, {
      ok: false,
      code: 'internal_error',
      message: error.message,
    });
    process.exit(1);
  }
}
