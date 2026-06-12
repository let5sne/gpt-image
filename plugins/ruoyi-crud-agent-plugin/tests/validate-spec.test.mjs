import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadAndValidateSpec } from '../scripts/lib/spec-loader.mjs';

test('product-plan example matches CRUD schema', () => {
  const result = loadAndValidateSpec(new URL('../examples/product-plan.yaml', import.meta.url).pathname);
  assert.equal(result.valid, true);
  assert.equal(result.spec.module.name, 'productPlan');
  assert.equal(result.spec.module.table, 'biz_product_plan');
  assert.equal(result.spec.fields.length, 6);
});

test('invalid product-plan fixture reports field path', () => {
  const result = loadAndValidateSpec(new URL('./fixtures/invalid-product-plan.yaml', import.meta.url).pathname);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.instancePath === '/fields/0/name'));
});
