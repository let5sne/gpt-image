import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { generateBackendModule } from '../scripts/lib/backend-generator.mjs';
import { generateFrontendModule } from '../scripts/lib/frontend-generator.mjs';
import { loadAndValidateSpec } from '../scripts/lib/spec-loader.mjs';
import { verifyGeneratedFiles, verifyModule } from '../scripts/verify-module.mjs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(testsDir, '..');
const examplePath = path.join(pluginRoot, 'examples/product-plan.yaml');
const invalidFixturePath = path.join(testsDir, 'fixtures/invalid-product-plan.yaml');
const verifyCliPath = path.join(pluginRoot, 'scripts/verify-module.mjs');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ruoyi-verify-'));
}

function loadExampleSpec() {
  const result = loadAndValidateSpec(examplePath);
  assert.equal(result.valid, true);
  return result.spec;
}

function runVerifyCli(args) {
  return spawnSync(process.execPath, [verifyCliPath, ...args], {
    cwd: pluginRoot,
    encoding: 'utf8',
  });
}

function generateExample(root) {
  const backendRoot = path.join(root, 'backend');
  const frontendRoot = path.join(root, 'frontend');
  const spec = loadExampleSpec();

  assert.equal(generateBackendModule(spec, backendRoot).ok, true);
  assert.equal(generateFrontendModule(spec, frontendRoot).ok, true);

  return { backendRoot, frontendRoot, spec };
}

function replaceDialogFormContent(content, variableName, search, replacement) {
  const start = content.indexOf(`<el-form ref="${variableName}FormRef"`);
  assert.notEqual(start, -1);
  const end = content.indexOf('</el-form>', start);
  assert.notEqual(end, -1);
  const section = content.slice(start, end);
  assert.ok(section.includes(search));
  return `${content.slice(0, start)}${section.replace(search, replacement)}${content.slice(end)}`;
}

test('static verifier detects missing required files', () => {
  const root = tempRoot();
  const spec = loadExampleSpec();
  const result = verifyGeneratedFiles({
    backendRoot: path.join(root, 'backend'),
    frontendRoot: path.join(root, 'frontend'),
    spec,
  });

  assert.equal(result.ok, false);
  assert.ok(result.missingFiles.some((file) => file.endsWith('ProductPlanController.java')));
  assert.ok(result.missingFiles.some((file) => file.endsWith('ruoyi_business_product_plan.sql')));
  assert.ok(result.missingFiles.some((file) => file.endsWith('src/api/business/product-plan/index.ts')));
  assert.ok(result.missingFiles.some((file) => file.endsWith('src/views/business/product-plan/index.vue')));
});

test('static verifier checks every generated backend and frontend file', () => {
  const root = tempRoot();
  const { backendRoot, frontendRoot, spec } = generateExample(root);
  const servicePath = path.join(
    backendRoot,
    'ruoyi-modules/ruoyi-business/src/main/java/org/dromara/business/product/service/IProductPlanService.java',
  );

  fs.rmSync(servicePath);
  const result = verifyGeneratedFiles({ backendRoot, frontendRoot, spec });

  assert.equal(result.ok, false);
  assert.ok(result.missingFiles.some((file) => file.endsWith('IProductPlanService.java')));
});

test('static verifier passes on generated backend and frontend files', () => {
  const root = tempRoot();
  const { backendRoot, frontendRoot, spec } = generateExample(root);

  const result = verifyGeneratedFiles({ backendRoot, frontendRoot, spec });

  assert.equal(result.ok, true);
  assert.ok(result.generatedFiles.includes('script/sql/ruoyi_business_product_plan.sql'));
  assert.ok(result.generatedFiles.includes('src/api/business/product-plan/index.ts'));
  assert.ok(result.generatedFiles.includes('src/views/business/product-plan/index.vue'));
});

test('static verifier fails when generated page misses an accepted form field', () => {
  const root = tempRoot();
  const { backendRoot, frontendRoot, spec } = generateExample(root);

  const pagePath = path.join(frontendRoot, 'src/views/business/product-plan/index.vue');
  const page = fs.readFileSync(pagePath, 'utf8').replaceAll('prop="planCode"', 'prop="removedPlanCode"');
  fs.writeFileSync(pagePath, page);

  const result = verifyGeneratedFiles({ backendRoot, frontendRoot, spec });

  assert.equal(result.ok, false);
  assert.ok(result.checks.some((check) => (
    check.code === 'dialog_form_field_marker'
    && check.message.includes('prop="planCode"')
    && check.ok === false
  )));
});

test('static verifier requires acceptance form fields inside the dialog form', () => {
  const root = tempRoot();
  const { backendRoot, frontendRoot, spec } = generateExample(root);
  const pagePath = path.join(frontendRoot, 'src/views/business/product-plan/index.vue');
  const page = fs.readFileSync(pagePath, 'utf8');
  const editedPage = replaceDialogFormContent(page, spec.derived.variableName, 'prop="planCode"', 'prop="removedPlanCode"');
  fs.writeFileSync(pagePath, editedPage);

  assert.ok(editedPage.includes('prop="planCode"'));

  const result = verifyGeneratedFiles({ backendRoot, frontendRoot, spec });

  assert.equal(result.ok, false);
  assert.ok(result.checks.some((check) => (
    check.code === 'dialog_form_field_marker'
    && check.message.includes('prop="planCode"')
    && check.ok === false
  )));
});

test('routeVisible static evidence fails when menu SQL is missing the route component', () => {
  const root = tempRoot();
  const { backendRoot, frontendRoot, spec } = generateExample(root);
  const sqlPath = path.join(backendRoot, 'script/sql/ruoyi_business_product_plan.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8').replace('business/product-plan/index', 'business/missing-route/index');
  fs.writeFileSync(sqlPath, sql);

  const result = verifyGeneratedFiles({ backendRoot, frontendRoot, spec });

  assert.equal(result.ok, false);
  assert.ok(result.checks.some((check) => (
    check.code === 'routeVisible_sql_component_path'
    && check.ok === false
  )));
});

test('smokeCrudStatic fails when controller or frontend CRUD markers are missing', () => {
  const root = tempRoot();
  const { backendRoot, frontendRoot, spec } = generateExample(root);
  const controllerPath = path.join(
    backendRoot,
    'ruoyi-modules/ruoyi-business/src/main/java/org/dromara/business/product/controller/ProductPlanController.java',
  );
  const apiPath = path.join(frontendRoot, 'src/api/business/product-plan/index.ts');

  fs.writeFileSync(
    controllerPath,
    fs.readFileSync(controllerPath, 'utf8').replace('@PostMapping()', '@PostMapping("/missing-add")'),
  );
  fs.writeFileSync(
    apiPath,
    fs.readFileSync(apiPath, 'utf8').replace('export const delProductPlan', 'export const removedProductPlan'),
  );

  const result = verifyGeneratedFiles({ backendRoot, frontendRoot, spec });

  assert.equal(result.ok, false);
  assert.ok(result.checks.some((check) => (
    check.code === 'smokeCrudStatic_controller_add'
    && check.ok === false
  )));
  assert.ok(result.checks.some((check) => (
    check.code === 'smokeCrudStatic_frontend_delete'
    && check.ok === false
  )));
});

test('verifyModule skips compile and build when static checks fail', () => {
  const root = tempRoot();
  const calls = [];
  const runner = (command, args, options) => {
    calls.push({ command, args, options });
    return {
      command,
      cwd: options.cwd,
      status: 0,
      stdout: '',
      stderr: '',
    };
  };

  const result = verifyModule(examplePath, {
    backendRoot: path.join(root, 'missing-backend'),
    frontendRoot: path.join(root, 'missing-frontend'),
    runCommand: runner,
  });

  assert.equal(result.ok, false);
  assert.equal(result.environment.ok, true);
  assert.equal(result.backendCompile.skipped, true);
  assert.equal(result.backendCompile.reason, 'static checks failed');
  assert.equal(result.frontendInstall.skipped, true);
  assert.equal(result.frontendInstall.reason, 'static checks failed');
  assert.equal(result.frontendBuild.skipped, true);
  assert.equal(result.frontendBuild.reason, 'static checks failed');
  assert.deepEqual(calls.map((call) => [call.command, call.args.join(' ')]), [
    ['java', '-version'],
    ['mvn', '-version'],
    ['node', '--version'],
    ['pnpm', '--version'],
  ]);
});

test('verifyModule installs frontend dependencies before build when vite is missing', () => {
  const root = tempRoot();
  const { backendRoot, frontendRoot } = generateExample(root);
  const calls = [];
  const runner = (command, args, options) => {
    calls.push({ command, args, options });
    return {
      command,
      cwd: options.cwd,
      status: 0,
      stdout: '',
      stderr: '',
    };
  };

  const result = verifyModule(examplePath, { backendRoot, frontendRoot, runCommand: runner });

  assert.equal(result.ok, true);
  assert.equal(result.frontendInstall.ok, true);
  assert.equal(result.frontendInstall.commandLine, 'pnpm install');
  assert.equal(result.frontendBuild.ok, true);
  assert.deepEqual(calls.map((call) => [call.command, call.args.join(' ')]), [
    ['java', '-version'],
    ['mvn', '-version'],
    ['node', '--version'],
    ['pnpm', '--version'],
    ['mvn', '-pl ruoyi-admin -am -DskipTests compile'],
    ['pnpm', 'install'],
    ['pnpm', 'build:prod'],
  ]);
  assert.equal(calls.at(-2).options.cwd, frontendRoot);
  assert.equal(calls.at(-1).options.cwd, frontendRoot);
});

test('verifyModule skips frontend install and build when backend compile fails', () => {
  const root = tempRoot();
  const { backendRoot, frontendRoot } = generateExample(root);
  const calls = [];
  const runner = (command, args, options) => {
    calls.push({ command, args, options });
    const isBackendCompile = command === 'mvn' && args.includes('compile');
    return {
      command,
      cwd: options.cwd,
      status: isBackendCompile ? 1 : 0,
      stdout: '',
      stderr: isBackendCompile ? 'compile failed' : '',
    };
  };

  const result = verifyModule(examplePath, { backendRoot, frontendRoot, runCommand: runner });

  assert.equal(result.ok, false);
  assert.equal(result.backendCompile.ok, false);
  assert.equal(result.frontendInstall.skipped, true);
  assert.equal(result.frontendInstall.reason, 'backend compile failed');
  assert.equal(result.frontendBuild.skipped, true);
  assert.equal(result.frontendBuild.reason, 'backend compile failed');
  assert.deepEqual(calls.map((call) => [call.command, call.args.join(' ')]), [
    ['java', '-version'],
    ['mvn', '-version'],
    ['node', '--version'],
    ['pnpm', '--version'],
    ['mvn', '-pl ruoyi-admin -am -DskipTests compile'],
  ]);
});

test('verifyModule skips frontend build when dependency install fails', () => {
  const root = tempRoot();
  const { backendRoot, frontendRoot } = generateExample(root);
  const calls = [];
  const runner = (command, args, options) => {
    calls.push({ command, args, options });
    return {
      command,
      cwd: options.cwd,
      status: command === 'pnpm' && args[0] === 'install' ? 1 : 0,
      stdout: '',
      stderr: command === 'pnpm' && args[0] === 'install' ? 'install failed' : '',
    };
  };

  const result = verifyModule(examplePath, { backendRoot, frontendRoot, runCommand: runner });

  assert.equal(result.ok, false);
  assert.equal(result.frontendInstall.ok, false);
  assert.equal(result.frontendInstall.commandLine, 'pnpm install');
  assert.equal(result.frontendBuild.skipped, true);
  assert.equal(result.frontendBuild.reason, 'frontend install failed');
  assert.deepEqual(calls.map((call) => [call.command, call.args.join(' ')]), [
    ['java', '-version'],
    ['mvn', '-version'],
    ['node', '--version'],
    ['pnpm', '--version'],
    ['mvn', '-pl ruoyi-admin -am -DskipTests compile'],
    ['pnpm', 'install'],
  ]);
});

test('verifyModule does not install frontend dependencies when vite exists', () => {
  const root = tempRoot();
  const { backendRoot, frontendRoot } = generateExample(root);
  const vitePath = path.join(frontendRoot, 'node_modules/.bin/vite');
  fs.mkdirSync(path.dirname(vitePath), { recursive: true });
  fs.writeFileSync(vitePath, '');
  const calls = [];
  const runner = (command, args, options) => {
    calls.push({ command, args, options });
    return {
      command,
      cwd: options.cwd,
      status: 0,
      stdout: '',
      stderr: '',
    };
  };

  const result = verifyModule(examplePath, { backendRoot, frontendRoot, runCommand: runner });

  assert.equal(result.ok, true);
  assert.equal(result.frontendInstall.ok, true);
  assert.equal(result.frontendInstall.skipped, true);
  assert.equal(result.frontendInstall.reason, 'vite already installed');
  assert.equal(result.frontendBuild.ok, true);
  assert.deepEqual(calls.map((call) => [call.command, call.args.join(' ')]), [
    ['java', '-version'],
    ['mvn', '-version'],
    ['node', '--version'],
    ['pnpm', '--version'],
    ['mvn', '-pl ruoyi-admin -am -DskipTests compile'],
    ['pnpm', 'build:prod'],
  ]);
});

test('verify-module CLI reports missing args as JSON stderr', () => {
  const result = runVerifyCli([]);
  const output = JSON.parse(result.stderr);

  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(output.ok, false);
  assert.equal(output.code, 'invalid_args');
});

test('verify-module CLI reports invalid specs as JSON stderr', () => {
  const result = runVerifyCli([invalidFixturePath]);
  const output = JSON.parse(result.stderr);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(output.ok, false);
  assert.equal(output.code, 'invalid_spec');
  assert.ok(output.errors.some((item) => item.instancePath === '/fields/0/name'));
});
