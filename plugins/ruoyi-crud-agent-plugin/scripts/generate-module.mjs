#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findBackendConflicts,
  writeBackendModule,
} from './lib/backend-generator.mjs';
import {
  findFrontendConflicts,
  writeFrontendModule,
} from './lib/frontend-generator.mjs';
import { loadAndValidateSpec, SpecInputError } from './lib/spec-loader.mjs';
import { sandboxRoot } from './lib/version-lock.mjs';

function printJson(stream, payload) {
  stream.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

function parseArgs(args) {
  const backendRoot = readOption(args, '--backend-root');
  const frontendRoot = readOption(args, '--frontend-root');
  const specPath = args.find((arg, index) => {
    const previous = args[index - 1];
    return !arg.startsWith('--') && previous !== '--backend-root' && previous !== '--frontend-root';
  });

  return {
    specPath,
    force: args.includes('--force'),
    backendRoot,
    frontendRoot,
  };
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

  const backendRoot = options.backendRoot || path.join(sandboxRoot, 'backend');
  const frontendRoot = options.frontendRoot || path.join(sandboxRoot, 'frontend');
  const backendConflicts = findBackendConflicts(result.spec, backendRoot);
  const frontendConflicts = findFrontendConflicts(result.spec, frontendRoot);

  if ((backendConflicts.length > 0 || frontendConflicts.length > 0) && options.force !== true) {
    return {
      ok: false,
      code: 'generation_conflict',
      backend: {
        ok: false,
        code: backendConflicts.length > 0 ? 'generation_conflict' : undefined,
        files: backendConflicts,
      },
      frontend: {
        ok: false,
        code: frontendConflicts.length > 0 ? 'generation_conflict' : undefined,
        files: frontendConflicts,
      },
    };
  }

  const backend = writeBackendModule(result.spec, backendRoot);
  const frontend = writeFrontendModule(result.spec, frontendRoot);

  return {
    ok: backend.ok && frontend.ok,
    backend,
    frontend,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { specPath, force, backendRoot, frontendRoot } = parseArgs(process.argv.slice(2));

  if (!specPath) {
    printJson(process.stderr, {
      ok: false,
      code: 'invalid_args',
      message: 'spec path is required',
    });
    process.exit(2);
  }

  if ((process.argv.includes('--backend-root') && !backendRoot) || (process.argv.includes('--frontend-root') && !frontendRoot)) {
    printJson(process.stderr, {
      ok: false,
      code: 'invalid_args',
      message: '--backend-root and --frontend-root require values',
    });
    process.exit(2);
  }

  try {
    const output = generateModule(specPath, { force, backendRoot, frontendRoot });
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
