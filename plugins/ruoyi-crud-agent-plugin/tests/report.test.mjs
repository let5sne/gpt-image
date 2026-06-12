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

function successfulVerifyResult() {
  return {
    ok: true,
    static: {
      generatedFiles: [
        'ruoyi-admin/src/main/java/org/dromara/business/controller/ProductPlanController.java',
        'src/views/business/product-plan/index.vue',
      ],
    },
    environment: {
      ok: true,
      commands: [
        {
          commandLine: 'java -version',
          status: 0,
          ok: true,
          stdout: '',
          stderr: 'openjdk version "17"',
        },
        {
          commandLine: 'mvn -version',
          status: 0,
          ok: true,
          stdout: 'Apache Maven 3.9.9',
          stderr: '',
        },
      ],
    },
    backendCompile: {
      commandLine: 'mvn -pl ruoyi-admin -am -DskipTests compile',
      status: 0,
      ok: true,
      stdout: 'BUILD SUCCESS',
      stderr: '',
    },
    frontendInstall: {
      commandLine: 'pnpm install',
      status: null,
      ok: true,
      skipped: true,
      reason: 'vite already installed',
      stdout: '',
      stderr: '',
    },
    frontendBuild: {
      commandLine: 'pnpm build:prod',
      status: 0,
      ok: true,
      stdout: 'built in 1.2s',
      stderr: '',
    },
  };
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

test('writeSpecReport writes verification-backed PASS report', () => {
  const reportDir = tempRoot();
  const result = writeSpecReport(examplePath, {
    reportDir,
    verifyResult: successfulVerifyResult(),
  });

  assert.equal(result.ok, true);
  const markdown = fs.readFileSync(result.reports.markdownPath, 'utf8');
  assert.ok(markdown.includes('Status: PASS'));
  assert.ok(markdown.includes('ProductPlanController.java'));
  assert.ok(markdown.includes('mvn -pl ruoyi-admin -am -DskipTests compile: passed'));
  assert.ok(markdown.includes('pnpm install: skipped (vite already installed)'));
  assert.equal(markdown.includes('PLANNED'), false);
  assert.equal(markdown.includes('planned'), false);

  const json = JSON.parse(fs.readFileSync(result.reports.jsonPath, 'utf8'));
  assert.equal(json.status, 'PASS');
  assert.equal(json.module.name, 'productPlan');
  assert.ok(json.generatedFiles.includes('src/views/business/product-plan/index.vue'));
  assert.ok(json.versions.ruoyiVuePlus.ref);
  assert.deepEqual(json.commands.map((command) => command.commandLine), [
    'java -version',
    'mvn -version',
    'mvn -pl ruoyi-admin -am -DskipTests compile',
    'pnpm install',
    'pnpm build:prod',
  ]);
  assert.deepEqual(json.commands.map((command) => command.status), [0, 0, 0, null, 0]);
});

test('writeSpecReport rejects failed verification without writing PASS report', () => {
  const reportDir = tempRoot();
  const result = writeSpecReport(examplePath, {
    reportDir,
    verifyResult: {
      ok: false,
      environment: {
        ok: true,
        commands: [],
      },
      backendCompile: {
        commandLine: 'mvn -pl ruoyi-admin -am -DskipTests compile',
        status: 1,
        ok: false,
        stdout: '',
        stderr: 'BUILD FAILURE',
      },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'verification_failed');
  assert.equal(fs.existsSync(path.join(reportDir, 'ruoyi-crud-agent-report.json')), false);
  assert.equal(fs.existsSync(path.join(reportDir, 'ruoyi-crud-agent-report.md')), false);
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
