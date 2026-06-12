import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { writeReports } from '../scripts/lib/report-writer.mjs';
import { writeSpecReport } from '../scripts/report.mjs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(testsDir, '..');
const examplePath = path.join(pluginRoot, 'examples/product-plan.yaml');
const invalidFixturePath = path.join(testsDir, 'fixtures/invalid-product-plan.yaml');
const reportCliPath = path.join(pluginRoot, 'scripts/report.mjs');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ruoyi-report-'));
}

function runReportCli(args) {
  return spawnSync(process.execPath, [reportCliPath, ...args], {
    cwd: pluginRoot,
    encoding: 'utf8',
  });
}

test('writeReports creates markdown and json reports', () => {
  const reportDir = tempRoot();
  const result = writeReports(reportDir, {
    status: 'PASS',
    module: {
      name: 'productPlan',
      title: '产品套餐',
    },
    versions: {
      ruoyiVuePlus: {
        repo: 'https://example.test/ruoyi',
        tag: 'v1',
        ref: 'abc123',
      },
    },
    commands: [
      {
        commandLine: 'npm test',
        status: 0,
      },
    ],
    generatedFiles: [
      'src/views/business/product-plan/index.vue',
    ],
  });

  assert.equal(result.ok, true);
  assert.ok(fs.existsSync(result.markdownPath));
  assert.ok(fs.existsSync(result.jsonPath));
  assert.ok(fs.readFileSync(result.markdownPath, 'utf8').includes('# RuoYi CRUD Agent Report'));

  const json = JSON.parse(fs.readFileSync(result.jsonPath, 'utf8'));
  assert.equal(json.module.name, 'productPlan');
});

test('writeSpecReport writes derived generated file list', () => {
  const reportDir = tempRoot();
  const result = writeSpecReport(examplePath, { reportDir });

  assert.equal(result.ok, true);
  assert.ok(fs.readFileSync(result.reports.markdownPath, 'utf8').includes('ProductPlanController.java'));

  const json = JSON.parse(fs.readFileSync(result.reports.jsonPath, 'utf8'));
  assert.equal(json.module.name, 'productPlan');
  assert.ok(json.generatedFiles.includes('src/views/business/product-plan/index.vue'));
  assert.ok(json.versions.ruoyiVuePlus.ref);
});

test('report CLI reports missing args as JSON stderr', () => {
  const result = runReportCli([]);
  const output = JSON.parse(result.stderr);

  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(output.ok, false);
  assert.equal(output.code, 'invalid_args');
});

test('report CLI reports invalid specs as JSON stderr', () => {
  const result = runReportCli([invalidFixturePath]);
  const output = JSON.parse(result.stderr);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(output.ok, false);
  assert.equal(output.code, 'invalid_spec');
  assert.ok(output.errors.some((item) => item.instancePath === '/fields/0/name'));
});
