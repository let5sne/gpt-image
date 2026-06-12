#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBackendGeneratedFiles } from './lib/backend-generator.mjs';
import { runCommand } from './lib/command.mjs';
import { getFrontendGeneratedFiles } from './lib/frontend-generator.mjs';
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
    backendRoot,
    frontendRoot,
  };
}

function commandResult(command, args, options = {}) {
  const result = runCommand(command, args, options);
  return {
    ...result,
    args,
    commandLine: [command, ...args].join(' '),
    ok: result.status === 0,
  };
}

function skippedCommand(commandLine, reason) {
  return {
    commandLine,
    status: null,
    ok: false,
    skipped: true,
    reason,
    stdout: '',
    stderr: '',
  };
}

function readFileIfPresent(filePath) {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  return fs.readFileSync(filePath, 'utf8');
}

function includesMarker(content, marker) {
  return typeof content === 'string' && content.includes(marker);
}

function staticCheck(ok, code, filePath, message) {
  return { ok, code, filePath, message };
}

function relativeGeneratedFiles(spec, backendRoot, frontendRoot) {
  return [
    ...getBackendGeneratedFiles(spec, backendRoot),
    ...getFrontendGeneratedFiles(spec, frontendRoot),
  ].map((entry) => entry.relativePath);
}

function requiredGeneratedFiles(spec, backendRoot, frontendRoot) {
  const backendFiles = getBackendGeneratedFiles(spec, backendRoot);
  const frontendFiles = getFrontendGeneratedFiles(spec, frontendRoot);
  return {
    controller: backendFiles.find((entry) => entry.relativePath.endsWith(`/${spec.derived.className}Controller.java`)),
    sql: backendFiles.find((entry) => entry.relativePath.startsWith('script/sql/') && entry.relativePath.endsWith('.sql')),
    frontendApi: frontendFiles.find((entry) => entry.relativePath === `${spec.derived.frontendApiDir}/index.ts`),
    frontendView: frontendFiles.find((entry) => entry.relativePath === `${spec.derived.frontendViewDir}/index.vue`),
  };
}

export function verifyGeneratedFiles({ backendRoot, frontendRoot, spec, expectedFields } = {}) {
  if (!spec) {
    throw new Error('spec is required');
  }

  const roots = {
    backendRoot: backendRoot || path.join(sandboxRoot, 'backend'),
    frontendRoot: frontendRoot || path.join(sandboxRoot, 'frontend'),
  };
  const required = requiredGeneratedFiles(spec, roots.backendRoot, roots.frontendRoot);
  const checks = [];

  for (const [name, entry] of Object.entries(required)) {
    if (!entry) {
      checks.push(staticCheck(false, 'missing_expected_path', undefined, `could not derive ${name} path`));
      continue;
    }
    checks.push(staticCheck(
      fs.existsSync(entry.filePath),
      `${name}_exists`,
      entry.filePath,
      `${entry.relativePath} exists`,
    ));
  }

  const controllerContent = readFileIfPresent(required.controller?.filePath);
  const apiContent = readFileIfPresent(required.frontendApi?.filePath);
  const pageContent = readFileIfPresent(required.frontendView?.filePath);
  const sqlContent = readFileIfPresent(required.sql?.filePath);
  const formFields = expectedFields || spec.acceptance?.frontend?.formFields || [];

  for (const fieldName of formFields) {
    checks.push(staticCheck(
      includesMarker(pageContent, `prop="${fieldName}"`),
      'form_field_marker',
      required.frontendView?.filePath,
      `page includes prop="${fieldName}"`,
    ));
  }

  checks.push(staticCheck(
    includesMarker(controllerContent, '@GetMapping("/list")'),
    'backend_list_route',
    required.controller?.filePath,
    'controller includes @GetMapping("/list")',
  ));
  checks.push(staticCheck(
    includesMarker(controllerContent, `@SaCheckPermission("${spec.permissions.list}")`),
    'backend_list_permission',
    required.controller?.filePath,
    `controller includes ${spec.permissions.list}`,
  ));
  checks.push(staticCheck(
    includesMarker(apiContent, `${spec.derived.apiBase}/list`),
    'frontend_list_api',
    required.frontendApi?.filePath,
    `frontend API includes ${spec.derived.apiBase}/list`,
  ));

  for (const permission of [
    spec.permissions.create,
    spec.permissions.update,
    spec.permissions.delete,
    spec.permissions.export,
  ].filter(Boolean)) {
    checks.push(staticCheck(
      includesMarker(pageContent, permission),
      'frontend_permission',
      required.frontendView?.filePath,
      `frontend view includes ${permission}`,
    ));
  }

  checks.push(staticCheck(
    includesMarker(sqlContent, spec.permissions.list),
    'sql_list_permission',
    required.sql?.filePath,
    `SQL includes ${spec.permissions.list}`,
  ));

  const ok = checks.every((check) => check.ok);

  return {
    ok,
    roots,
    checks,
    missingFiles: checks
      .filter((check) => !check.ok && check.code.endsWith('_exists'))
      .map((check) => check.filePath),
    generatedFiles: relativeGeneratedFiles(spec, roots.backendRoot, roots.frontendRoot),
  };
}

export function verifyEnvironment() {
  const commands = [
    commandResult('java', ['-version']),
    commandResult('mvn', ['-version']),
    commandResult('node', ['--version']),
    commandResult('pnpm', ['--version']),
  ];

  return {
    ok: commands.every((command) => command.ok),
    commands,
    failures: commands.filter((command) => !command.ok).map((command) => command.commandLine),
  };
}

export function verifyModule(specPath, options = {}) {
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
  const staticResult = verifyGeneratedFiles({
    backendRoot,
    frontendRoot,
    spec: result.spec,
  });
  const environment = verifyEnvironment();
  const backendCompile = environment.ok
    ? commandResult('mvn', ['-pl', 'ruoyi-admin', '-am', '-DskipTests', 'compile'], { cwd: backendRoot })
    : skippedCommand('mvn -pl ruoyi-admin -am -DskipTests compile', 'environment checks failed');
  const frontendBuild = environment.ok
    ? commandResult('pnpm', ['build:prod'], { cwd: frontendRoot })
    : skippedCommand('pnpm build:prod', 'environment checks failed');

  return {
    ok: staticResult.ok && environment.ok && backendCompile.ok && frontendBuild.ok,
    static: staticResult,
    environment,
    backendCompile,
    frontendBuild,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { specPath, backendRoot, frontendRoot } = parseArgs(process.argv.slice(2));

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
    const output = verifyModule(specPath, { backendRoot, frontendRoot });
    if (output.code === 'invalid_spec') {
      printJson(process.stderr, output);
      process.exit(1);
    }
    printJson(process.stdout, output);
    process.exit(output.ok ? 0 : 1);
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
