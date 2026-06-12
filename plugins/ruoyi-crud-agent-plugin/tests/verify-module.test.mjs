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
import { verifyGeneratedFiles } from '../scripts/verify-module.mjs';

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

test('static verifier passes on generated backend and frontend files', () => {
  const root = tempRoot();
  const backendRoot = path.join(root, 'backend');
  const frontendRoot = path.join(root, 'frontend');
  const spec = loadExampleSpec();

  assert.equal(generateBackendModule(spec, backendRoot).ok, true);
  assert.equal(generateFrontendModule(spec, frontendRoot).ok, true);

  const result = verifyGeneratedFiles({ backendRoot, frontendRoot, spec });

  assert.equal(result.ok, true);
  assert.ok(result.generatedFiles.includes('script/sql/ruoyi_business_product_plan.sql'));
  assert.ok(result.generatedFiles.includes('src/api/business/product-plan/index.ts'));
  assert.ok(result.generatedFiles.includes('src/views/business/product-plan/index.vue'));
});

test('static verifier fails when generated page misses an accepted form field', () => {
  const root = tempRoot();
  const backendRoot = path.join(root, 'backend');
  const frontendRoot = path.join(root, 'frontend');
  const spec = loadExampleSpec();

  generateBackendModule(spec, backendRoot);
  generateFrontendModule(spec, frontendRoot);

  const pagePath = path.join(frontendRoot, 'src/views/business/product-plan/index.vue');
  const page = fs.readFileSync(pagePath, 'utf8').replaceAll('prop="planCode"', 'prop="removedPlanCode"');
  fs.writeFileSync(pagePath, page);

  const result = verifyGeneratedFiles({ backendRoot, frontendRoot, spec });

  assert.equal(result.ok, false);
  assert.ok(result.checks.some((check) => (
    check.code === 'form_field_marker'
    && check.message.includes('prop="planCode"')
    && check.ok === false
  )));
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
