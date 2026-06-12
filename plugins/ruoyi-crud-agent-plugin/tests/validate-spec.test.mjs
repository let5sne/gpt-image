import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadAndValidateSpec } from '../scripts/lib/spec-loader.mjs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(testsDir, '..');
const examplePath = path.join(pluginRoot, 'examples/product-plan.yaml');
const expectedPath = path.join(testsDir, 'fixtures/product-plan.expected.json');
const invalidFixturePath = path.join(testsDir, 'fixtures/invalid-product-plan.yaml');
const validateCliPath = path.join(pluginRoot, 'scripts/validate-spec.mjs');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeTempSpec(content, extension = '.yaml') {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruoyi-spec-'));
  const filePath = path.join(tempDir, `spec${extension}`);
  fs.writeFileSync(filePath, content);
  return filePath;
}

function runValidateCli(args) {
  return spawnSync(process.execPath, [validateCliPath, ...args], {
    cwd: pluginRoot,
    encoding: 'utf8',
  });
}

test('product-plan example matches CRUD schema', () => {
  const result = loadAndValidateSpec(examplePath);
  const expectedDerived = readJson(expectedPath);

  assert.equal(result.valid, true);
  assert.equal(result.spec.module.name, 'productPlan');
  assert.equal(result.spec.module.table, 'biz_product_plan');
  assert.equal(result.spec.fields.length, 6);
  assert.deepEqual(result.spec.derived, expectedDerived);
});

test('invalid product-plan fixture reports field path', () => {
  const result = loadAndValidateSpec(invalidFixturePath);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.instancePath === '/fields/0/name'));
});

test('duplicate field names are semantic validation errors', () => {
  const content = fs.readFileSync(examplePath, 'utf8').replace('  - name: planName', '  - name: planCode');
  const result = loadAndValidateSpec(writeTempSpec(content));

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => (
    item.instancePath === '/fields/1/name' && item.keyword === 'duplicateField'
  )));
});

test('unknown frontend form fields are semantic validation errors', () => {
  const content = fs.readFileSync(examplePath, 'utf8')
    .replace('      - sortOrder\n  report:', '      - missingField\n  report:');
  const result = loadAndValidateSpec(writeTempSpec(content));

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => (
    item.instancePath === '/acceptance/frontend/formFields/5' && item.keyword === 'unknownFormField'
  )));
});

test('invalid enum defaults are semantic validation errors', () => {
  const content = fs.readFileSync(examplePath, 'utf8').replace('default: enabled', 'default: archived');
  const result = loadAndValidateSpec(writeTempSpec(content));

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => (
    item.instancePath === '/fields/4/default' && item.keyword === 'invalidEnumDefault'
  )));
});

test('wrong-type enum defaults are semantic validation errors', () => {
  const content = fs.readFileSync(examplePath, 'utf8').replace('default: enabled', 'default: 1');
  const result = loadAndValidateSpec(writeTempSpec(content));

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => (
    item.instancePath === '/fields/4/default' && item.keyword === 'invalidEnumDefault'
  )));
});

test('validate-spec CLI prints valid spec summary to stdout', () => {
  const result = runValidateCli(['examples/product-plan.yaml']);
  const output = JSON.parse(result.stdout);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(output.ok, true);
  assert.equal(output.fieldCount, 6);
  assert.deepEqual(output.derived, readJson(expectedPath));
});

test('validate-spec CLI reports missing args as JSON stderr', () => {
  const result = runValidateCli([]);
  const output = JSON.parse(result.stderr);

  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(output.ok, false);
  assert.equal(output.code, 'invalid_args');
});

test('validate-spec CLI reports missing files as JSON stderr', () => {
  const result = runValidateCli(['tests/fixtures/missing-product-plan.yaml']);
  const output = JSON.parse(result.stderr);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(output.ok, false);
  assert.equal(output.code, 'file_not_found');
  assert.doesNotMatch(result.stderr, /Error:|^\s+at /m);
});

test('validate-spec CLI reports unsupported extensions as JSON stderr', () => {
  const specPath = writeTempSpec('not yaml', '.txt');
  const result = runValidateCli([specPath]);
  const output = JSON.parse(result.stderr);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(output.ok, false);
  assert.equal(output.code, 'unsupported_extension');
  assert.doesNotMatch(result.stderr, /Error:|^\s+at /m);
});

test('validate-spec CLI reports malformed JSON as JSON stderr', () => {
  const specPath = writeTempSpec('{', '.json');
  const result = runValidateCli([specPath]);
  const output = JSON.parse(result.stderr);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(output.ok, false);
  assert.equal(output.code, 'invalid_json');
  assert.doesNotMatch(result.stderr, /Error:|^\s+at /m);
});

test('validate-spec CLI reports malformed YAML as JSON stderr', () => {
  const specPath = writeTempSpec('module: [');
  const result = runValidateCli([specPath]);
  const output = JSON.parse(result.stderr);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(output.ok, false);
  assert.equal(output.code, 'invalid_yaml');
  assert.doesNotMatch(result.stderr, /Error:|^\s+at /m);
});

test('validate-spec CLI reports invalid fixture errors as JSON stderr', () => {
  const result = runValidateCli(['tests/fixtures/invalid-product-plan.yaml']);
  const output = JSON.parse(result.stderr);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(output.ok, false);
  assert.equal(output.code, 'invalid_spec');
  assert.ok(output.errors.some((item) => item.instancePath === '/fields/0/name'));
});
