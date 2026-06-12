import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { generateBackendModule } from '../scripts/lib/backend-generator.mjs';
import { generateFrontendModule } from '../scripts/lib/frontend-generator.mjs';
import { loadAndValidateSpec } from '../scripts/lib/spec-loader.mjs';

test('generator writes product plan backend and frontend files', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ruoyi-crud-agent-'));
  const backendRoot = path.join(tempRoot, 'backend');
  const frontendRoot = path.join(tempRoot, 'frontend');
  fs.mkdirSync(backendRoot, { recursive: true });
  fs.mkdirSync(frontendRoot, { recursive: true });

  const { spec } = loadAndValidateSpec(new URL('../examples/product-plan.yaml', import.meta.url).pathname);
  const backend = generateBackendModule(spec, backendRoot);
  const frontend = generateFrontendModule(spec, frontendRoot);

  assert.equal(backend.ok, true);
  assert.equal(frontend.ok, true);
  assert.ok(backend.files.every((file) => path.isAbsolute(file)));
  assert.ok(frontend.files.every((file) => path.isAbsolute(file)));
  assert.ok(backend.files.some((file) => file.endsWith('ProductPlanController.java')));
  assert.ok(backend.files.some((file) => file.endsWith('biz_product_plan.sql')));
  assert.ok(frontend.files.some((file) => file.endsWith('src/api/business/product-plan/index.ts')));
  assert.ok(frontend.files.some((file) => file.endsWith('src/views/business/product-plan/index.vue')));

  const controller = fs.readFileSync(backend.files.find((file) => file.endsWith('ProductPlanController.java')), 'utf8');
  assert.ok(controller.includes('@SaCheckPermission("business:productPlan:list")'));
  assert.ok(controller.includes('@RequestMapping("/business/productPlan")'));

  const page = fs.readFileSync(frontend.files.find((file) => file.endsWith('index.vue')), 'utf8');
  assert.ok(page.includes('v-hasPermi="[\'business:productPlan:add\']"'));
  assert.ok(page.includes('prop="planCode"'));
});
