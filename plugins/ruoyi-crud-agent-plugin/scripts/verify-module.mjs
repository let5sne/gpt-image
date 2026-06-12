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

function commandResult(command, args, options = {}, runner = runCommand) {
  const result = runner(command, args, options);
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

function generatedFileEntries(spec, backendRoot, frontendRoot) {
  return [
    ...getBackendGeneratedFiles(spec, backendRoot),
    ...getFrontendGeneratedFiles(spec, frontendRoot),
  ];
}

function relativeGeneratedFiles(spec, backendRoot, frontendRoot) {
  return generatedFileEntries(spec, backendRoot, frontendRoot).map((entry) => entry.relativePath);
}

function byRelativePath(entries) {
  return new Map(entries.map((entry) => [entry.relativePath, entry]));
}

function requiredGeneratedFiles(spec, backendRoot, frontendRoot) {
  const entries = byRelativePath(generatedFileEntries(spec, backendRoot, frontendRoot));
  const backendFiles = getBackendGeneratedFiles(spec, backendRoot);
  return {
    controller: backendFiles.find((entry) => entry.relativePath.endsWith(`/${spec.derived.className}Controller.java`)),
    sql: backendFiles.find((entry) => entry.relativePath.startsWith('script/sql/') && entry.relativePath.endsWith('.sql')),
    frontendApi: entries.get(`${spec.derived.frontendApiDir}/index.ts`),
    frontendView: entries.get(`${spec.derived.frontendViewDir}/index.vue`),
  };
}

function dialogFormSection(content, variableName) {
  if (typeof content !== 'string') {
    return '';
  }

  const formStart = content.indexOf(`<el-form ref="${variableName}FormRef"`);
  if (formStart === -1) {
    return '';
  }

  const formEnd = content.indexOf('</el-form>', formStart);
  if (formEnd === -1) {
    return content.slice(formStart);
  }

  return content.slice(formStart, formEnd);
}

function controllerCrudChecks(spec, controllerContent, controllerPath) {
  return [
    ['smokeCrudStatic_controller_list', '@GetMapping("/list")'],
    ['smokeCrudStatic_controller_get', '@GetMapping("/{id}")'],
    ['smokeCrudStatic_controller_add', '@PostMapping()'],
    ['smokeCrudStatic_controller_edit', '@PutMapping()'],
    ['smokeCrudStatic_controller_remove', '@DeleteMapping("/{ids}")'],
  ].map(([code, marker]) => staticCheck(
    includesMarker(controllerContent, marker),
    code,
    controllerPath,
    `controller CRUD surface includes ${marker}`,
  ));
}

function frontendCrudChecks(spec, apiContent, apiPath) {
  const className = spec.derived.className;
  return [
    ['smokeCrudStatic_frontend_list', `export const list${className}`],
    ['smokeCrudStatic_frontend_get', `export const get${className}`],
    ['smokeCrudStatic_frontend_add', `export const add${className}`],
    ['smokeCrudStatic_frontend_update', `export const update${className}`],
    ['smokeCrudStatic_frontend_delete', `export const del${className}`],
  ].map(([code, marker]) => staticCheck(
    includesMarker(apiContent, marker),
    code,
    apiPath,
    `frontend CRUD API includes ${marker}`,
  ));
}

export function verifyGeneratedFiles({ backendRoot, frontendRoot, spec, expectedFields } = {}) {
  if (!spec) {
    throw new Error('spec is required');
  }

  const roots = {
    backendRoot: backendRoot || path.join(sandboxRoot, 'backend'),
    frontendRoot: frontendRoot || path.join(sandboxRoot, 'frontend'),
  };
  const generatedEntries = generatedFileEntries(spec, roots.backendRoot, roots.frontendRoot);
  const required = requiredGeneratedFiles(spec, roots.backendRoot, roots.frontendRoot);
  const checks = [];

  for (const entry of generatedEntries) {
    checks.push(staticCheck(
      fs.existsSync(entry.filePath),
      'generated_file_exists',
      entry.filePath,
      `${entry.relativePath} exists`,
    ));
  }

  const controllerContent = readFileIfPresent(required.controller?.filePath);
  const apiContent = readFileIfPresent(required.frontendApi?.filePath);
  const pageContent = readFileIfPresent(required.frontendView?.filePath);
  const sqlContent = readFileIfPresent(required.sql?.filePath);
  const formContent = dialogFormSection(pageContent, spec.derived.variableName);
  const formFields = expectedFields || spec.acceptance?.frontend?.formFields || [];

  for (const fieldName of formFields) {
    checks.push(staticCheck(
      includesMarker(formContent, `prop="${fieldName}"`),
      'dialog_form_field_marker',
      required.frontendView?.filePath,
      `dialog form includes prop="${fieldName}"`,
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

  if (spec.acceptance?.frontend?.routeVisible === true) {
    checks.push(staticCheck(
      includesMarker(sqlContent, 'insert into sys_menu') && includesMarker(sqlContent, `${spec.module.menuPath}/index`),
      'routeVisible_sql_component_path',
      required.sql?.filePath,
      `SQL menu includes component path ${spec.module.menuPath}/index`,
    ));
    checks.push(staticCheck(
      includesMarker(sqlContent, spec.permissions.list),
      'routeVisible_sql_list_permission',
      required.sql?.filePath,
      `SQL menu includes list permission ${spec.permissions.list}`,
    ));
    checks.push(staticCheck(
      fs.existsSync(required.frontendApi?.filePath || ''),
      'routeVisible_frontend_api_exists',
      required.frontendApi?.filePath,
      'frontend API file exists for route',
    ));
    checks.push(staticCheck(
      fs.existsSync(required.frontendView?.filePath || ''),
      'routeVisible_frontend_view_exists',
      required.frontendView?.filePath,
      'frontend view file exists for route',
    ));
  }

  if (spec.acceptance?.backend?.smokeCrud === true) {
    checks.push(...controllerCrudChecks(spec, controllerContent, required.controller?.filePath));
    checks.push(...frontendCrudChecks(spec, apiContent, required.frontendApi?.filePath));
  }

  const ok = checks.every((check) => check.ok);

  return {
    ok,
    roots,
    checks,
    missingFiles: checks
      .filter((check) => !check.ok && check.code === 'generated_file_exists')
      .map((check) => check.filePath),
    generatedFiles: generatedEntries.map((entry) => entry.relativePath),
  };
}

export function verifyEnvironment(options = {}) {
  const runner = options.runCommand || runCommand;
  const commands = [
    commandResult('java', ['-version'], {}, runner),
    commandResult('mvn', ['-version'], {}, runner),
    commandResult('node', ['--version'], {}, runner),
    commandResult('pnpm', ['--version'], {}, runner),
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
  const runner = options.runCommand || runCommand;
  const environment = verifyEnvironment({ runCommand: runner });
  const buildSkipReason = !environment.ok
    ? 'environment checks failed'
    : 'static checks failed';
  const shouldBuild = environment.ok && staticResult.ok;
  const backendCompile = shouldBuild
    ? commandResult('mvn', ['-pl', 'ruoyi-admin', '-am', '-DskipTests', 'compile'], { cwd: backendRoot }, runner)
    : skippedCommand('mvn -pl ruoyi-admin -am -DskipTests compile', buildSkipReason);
  const frontendBuild = shouldBuild
    ? commandResult('pnpm', ['build:prod'], { cwd: frontendRoot }, runner)
    : skippedCommand('pnpm build:prod', buildSkipReason);

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
