#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBackendGeneratedFiles } from './lib/backend-generator.mjs';
import { getFrontendGeneratedFiles } from './lib/frontend-generator.mjs';
import { writeReports } from './lib/report-writer.mjs';
import { loadAndValidateSpec, pluginRoot, SpecInputError } from './lib/spec-loader.mjs';
import { loadVersionLock, sandboxRoot } from './lib/version-lock.mjs';

function printJson(stream, payload) {
  stream.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function generatedFileList(spec) {
  const backendRoot = path.join(sandboxRoot, 'backend');
  const frontendRoot = path.join(sandboxRoot, 'frontend');
  return [
    ...getBackendGeneratedFiles(spec, backendRoot),
    ...getFrontendGeneratedFiles(spec, frontendRoot),
  ].map((entry) => entry.relativePath);
}

function reportPayload(spec) {
  const versions = loadVersionLock();
  return {
    status: 'PLANNED',
    module: spec.module,
    versions: {
      ruoyiVuePlus: versions.ruoyiVuePlus,
      plusUi: versions.plusUi,
    },
    commands: [
      {
        commandLine: 'npm run validate',
        statusText: 'planned',
      },
      {
        commandLine: 'npm run generate',
        statusText: 'planned',
      },
      {
        commandLine: 'npm run verify',
        statusText: 'planned',
      },
    ],
    generatedFiles: generatedFileList(spec),
  };
}

export function writeSpecReport(specPath, options = {}) {
  const result = loadAndValidateSpec(specPath);
  if (!result.valid) {
    return {
      ok: false,
      code: 'invalid_spec',
      errors: result.errors,
    };
  }

  const reportDir = options.reportDir || path.join(pluginRoot, 'reports');
  const reports = writeReports(reportDir, reportPayload(result.spec));

  return {
    ok: true,
    reports,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const specPath = process.argv[2];

  if (!specPath) {
    printJson(process.stderr, {
      ok: false,
      code: 'invalid_args',
      message: 'spec path is required',
    });
    process.exit(2);
  }

  try {
    const output = writeSpecReport(specPath);
    if (output.code === 'invalid_spec') {
      printJson(process.stderr, output);
      process.exit(1);
    }
    printJson(process.stdout, output);
    process.exit(0);
  } catch (error) {
    const payload = {
      ok: false,
      code: 'invalid_spec',
      message: error.message,
      errors: error instanceof SpecInputError ? error.errors : undefined,
    };
    printJson(process.stderr, payload);
    process.exit(1);
  }
}
