import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { generateBackendModule } from '../scripts/lib/backend-generator.mjs';
import { generateFrontendModule } from '../scripts/lib/frontend-generator.mjs';
import { generateModule } from '../scripts/generate-module.mjs';
import { loadAndValidateSpec } from '../scripts/lib/spec-loader.mjs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(testsDir, '..');
const examplePath = path.join(pluginRoot, 'examples/product-plan.yaml');
const generateCliPath = path.join(pluginRoot, 'scripts/generate-module.mjs');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ruoyi-crud-agent-'));
}

function loadExampleSpec() {
  const result = loadAndValidateSpec(examplePath);
  assert.equal(result.valid, true);
  return result.spec;
}

function writeSpec(content) {
  const root = tempRoot();
  const specPath = path.join(root, 'spec.yaml');
  fs.writeFileSync(specPath, content);
  const result = loadAndValidateSpec(specPath);
  assert.equal(result.valid, true);
  return result.spec;
}

function countMatches(value, pattern) {
  return value.match(pattern)?.length || 0;
}

test('generator writes product plan backend and frontend files', () => {
  const root = tempRoot();
  const backendRoot = path.join(root, 'backend');
  const frontendRoot = path.join(root, 'frontend');
  fs.mkdirSync(backendRoot, { recursive: true });
  fs.mkdirSync(frontendRoot, { recursive: true });

  const spec = loadExampleSpec();
  const backend = generateBackendModule(spec, backendRoot);
  const frontend = generateFrontendModule(spec, frontendRoot);

  assert.equal(backend.ok, true);
  assert.equal(frontend.ok, true);
  assert.ok(backend.files.every((file) => path.isAbsolute(file)));
  assert.ok(frontend.files.every((file) => path.isAbsolute(file)));
  assert.ok(backend.files.some((file) => file.endsWith('ProductPlanController.java')));
  assert.ok(backend.files.some((file) => file.endsWith('ruoyi_business_product_plan.sql')));
  assert.ok(frontend.files.some((file) => file.endsWith('src/api/business/product-plan/index.ts')));
  assert.ok(frontend.files.some((file) => file.endsWith('src/views/business/product-plan/index.vue')));

  const controller = fs.readFileSync(backend.files.find((file) => file.endsWith('ProductPlanController.java')), 'utf8');
  assert.ok(controller.includes('@SaCheckPermission("business:productPlan:list")'));
  assert.ok(controller.includes('@RequestMapping("/business/productPlan")'));
  assert.ok(controller.includes('@GetMapping("/list")'));

  const serviceImpl = fs.readFileSync(backend.files.find((file) => file.endsWith('ProductPlanServiceImpl.java')), 'utf8');
  assert.ok(serviceImpl.includes('StringUtils.isNotBlank(bo.getPlanCode())'));
  assert.ok(serviceImpl.includes('StringUtils.isNotBlank(bo.getStatus())'));
  assert.doesNotMatch(serviceImpl, /bo\.getStatus\(\) != null, ProductPlan::getStatus/);

  const sql = fs.readFileSync(backend.files.find((file) => file.endsWith('ruoyi_business_product_plan.sql')), 'utf8');
  assert.ok(sql.includes("create table if not exists biz_product_plan (\n  id bigint not null comment '主键',"));
  assert.ok(sql.includes("insert into sys_menu values('19006', '产品套餐导出'"));

  const page = fs.readFileSync(frontend.files.find((file) => file.endsWith('index.vue')), 'utf8');
  assert.ok(page.includes('v-hasPermi="[\'business:productPlan:add\']"'));
  assert.ok(page.includes('prop="planCode"'));
  assert.ok(page.includes('status: undefined'));
});

test('generateModule honors custom roots and CLI root overrides', () => {
  const root = tempRoot();
  const backendRoot = path.join(root, 'custom-backend');
  const frontendRoot = path.join(root, 'custom-frontend');

  const result = generateModule(examplePath, { backendRoot, frontendRoot });
  assert.equal(result.ok, true);
  assert.ok(result.backend.files.every((file) => file.startsWith(backendRoot)));
  assert.ok(result.frontend.files.every((file) => file.startsWith(frontendRoot)));
  assert.ok(fs.existsSync(path.join(backendRoot, 'ruoyi-modules/ruoyi-business/src/main/java/org/dromara/business/product/controller/ProductPlanController.java')));
  assert.ok(fs.existsSync(path.join(frontendRoot, 'src/api/business/product-plan/index.ts')));

  const cliBackendRoot = path.join(root, 'cli-backend');
  const cliFrontendRoot = path.join(root, 'cli-frontend');
  const cli = spawnSync(process.execPath, [
    generateCliPath,
    examplePath,
    '--backend-root',
    cliBackendRoot,
    '--frontend-root',
    cliFrontendRoot,
    '--force',
  ], {
    cwd: pluginRoot,
    encoding: 'utf8',
  });
  const output = JSON.parse(cli.stdout);

  assert.equal(cli.status, 0);
  assert.equal(cli.stderr, '');
  assert.equal(output.ok, true);
  assert.ok(output.backend.files.every((file) => file.startsWith(cliBackendRoot)));
  assert.ok(output.frontend.files.every((file) => file.startsWith(cliFrontendRoot)));
});

test('non-product specs drive package, class, paths, urls, and table SQL', () => {
  const spec = writeSpec(`
module:
  name: customerPlan
  title: 客户套餐
  package: org.dromara.business.customer
  table: biz_customer_plan
  menuPath: business/customer-plan
fields:
  - name: customerCode
    title: 客户编码
    type: string
    required: true
    unique: true
    list: true
    form: true
    search: true
  - name: status
    title: 状态
    type: enum
    required: true
    options: [enabled, disabled]
    default: enabled
    list: true
    form: true
    search: true
permissions:
  menu: business:customerPlan
  list: business:customerPlan:list
  create: business:customerPlan:add
  update: business:customerPlan:edit
  delete: business:customerPlan:remove
  export: business:customerPlan:export
acceptance:
  backend:
    compile: true
    smokeCrud: true
  frontend:
    build: true
    routeVisible: true
    formFields: [customerCode, status]
  report:
    format: [markdown, json]
`);
  const root = tempRoot();
  const backend = generateBackendModule(spec, path.join(root, 'backend'));
  const frontend = generateFrontendModule(spec, path.join(root, 'frontend'));

  assert.equal(backend.ok, true);
  assert.equal(frontend.ok, true);
  assert.ok(backend.files.some((file) => file.endsWith('org/dromara/business/customer/controller/CustomerPlanController.java')));
  assert.ok(frontend.files.some((file) => file.endsWith('src/api/business/customer-plan/index.ts')));
  assert.ok(frontend.files.some((file) => file.endsWith('src/views/business/customer-plan/index.vue')));

  const controller = fs.readFileSync(backend.files.find((file) => file.endsWith('CustomerPlanController.java')), 'utf8');
  assert.ok(controller.includes('@RequestMapping("/business/customerPlan")'));
  assert.ok(controller.includes('private final ICustomerPlanService customerPlanService;'));

  const api = fs.readFileSync(frontend.files.find((file) => file.endsWith('src/api/business/customer-plan/index.ts')), 'utf8');
  assert.ok(api.includes('export const listCustomerPlan'));
  assert.ok(api.includes('url: "/business/customerPlan/list"'));
  assert.ok(api.includes("from '@/api/business/customer-plan/types'"));

  const sql = fs.readFileSync(backend.files.find((file) => file.endsWith('ruoyi_business_customer_plan.sql')), 'utf8');
  assert.ok(sql.includes('create table if not exists biz_customer_plan'));
  assert.ok(sql.includes('customer_code varchar(128) not null'));
  assert.ok(sql.includes('insert into sys_menu values'));
  assert.ok(sql.includes("'客户套餐'"));
  assert.ok(sql.includes("'business/customer-plan/index'"));
  assert.ok(sql.includes("'business:customerPlan:list'"));
  assert.ok(sql.includes("'business:customerPlan:add'"));
  assert.ok(sql.includes("'business:customerPlan:edit'"));
  assert.ok(sql.includes("'business:customerPlan:remove'"));
  assert.ok(sql.includes("'business:customerPlan:export'"));
});

test('generated Java, Vue, and TS literals escape quotes and apostrophes', () => {
  const spec = writeSpec(`
module:
  name: quotePlan
  title: "报价\\"套餐's"
  package: org.dromara.business.quote
  table: biz_quote_plan
  menuPath: business/quote-plan
fields:
  - name: quoteCode
    title: "编码\\"A's"
    type: string
    required: true
    unique: true
    list: true
    form: true
    search: true
  - name: status
    title: "状态\\"S's"
    type: enum
    required: true
    options:
      - enabled
      - "o'clock"
    default: "o'clock"
    list: true
    form: true
    search: true
permissions:
  menu: business:quotePlan
  list: business:quotePlan:list
  create: business:quotePlan:add
  update: business:quotePlan:edit
  delete: business:quotePlan:remove
  export: business:quotePlan:export
acceptance:
  backend:
    compile: true
    smokeCrud: true
  frontend:
    build: true
    routeVisible: true
    formFields: [quoteCode, status]
  report:
    format: [markdown, json]
`);
  const root = tempRoot();
  const backend = generateBackendModule(spec, path.join(root, 'backend'));
  const frontend = generateFrontendModule(spec, path.join(root, 'frontend'));
  const bo = fs.readFileSync(backend.files.find((file) => file.endsWith('QuotePlanBo.java')), 'utf8');
  const page = fs.readFileSync(frontend.files.find((file) => file.endsWith('index.vue')), 'utf8');
  const api = fs.readFileSync(frontend.files.find((file) => file.endsWith('index.ts')), 'utf8');

  assert.ok(bo.includes('@NotBlank(message = "编码\\"A\'s不能为空")'));
  assert.ok(page.includes('label="编码&quot;A\'s"'));
  assert.ok(page.includes('value="o\'clock"'));
  assert.ok(page.includes('title.value = "添加报价\\"套餐\'s";'));
  assert.ok(api.includes('url: "/business/quotePlan/list"'));
});

test('generateModule conflict preflight writes nothing across backend and frontend', () => {
  const root = tempRoot();
  const backendRoot = path.join(root, 'backend');
  const frontendRoot = path.join(root, 'frontend');
  const frontendConflict = path.join(frontendRoot, 'src/api/business/product-plan/index.ts');
  fs.mkdirSync(path.dirname(frontendConflict), { recursive: true });
  fs.writeFileSync(frontendConflict, 'existing');

  const result = generateModule(examplePath, { backendRoot, frontendRoot });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'generation_conflict');
  assert.deepEqual(result.backend.files, []);
  assert.ok(result.frontend.files.includes(frontendConflict));
  assert.equal(fs.existsSync(path.join(backendRoot, 'ruoyi-modules/pom.xml')), false);
  assert.equal(fs.existsSync(path.join(backendRoot, 'ruoyi-modules/ruoyi-business/src/main/java/org/dromara/business/product/controller/ProductPlanController.java')), false);
  assert.equal(fs.readFileSync(frontendConflict, 'utf8'), 'existing');
});

test('force overwrites generated files and POM updates stay idempotent', () => {
  const root = tempRoot();
  const backendRoot = path.join(root, 'backend');
  const frontendRoot = path.join(root, 'frontend');
  const first = generateModule(examplePath, { backendRoot, frontendRoot });
  assert.equal(first.ok, true);

  const controllerPath = path.join(backendRoot, 'ruoyi-modules/ruoyi-business/src/main/java/org/dromara/business/product/controller/ProductPlanController.java');
  const pagePath = path.join(frontendRoot, 'src/views/business/product-plan/index.vue');
  fs.writeFileSync(controllerPath, 'stale');
  fs.writeFileSync(pagePath, 'stale');

  const conflict = generateModule(examplePath, { backendRoot, frontendRoot });
  assert.equal(conflict.ok, false);
  assert.equal(fs.readFileSync(controllerPath, 'utf8'), 'stale');

  const forced = generateModule(examplePath, { backendRoot, frontendRoot, force: true });
  assert.equal(forced.ok, true);
  assert.ok(fs.readFileSync(controllerPath, 'utf8').includes('ProductPlanController'));
  assert.ok(fs.readFileSync(pagePath, 'utf8').includes('productPlanList'));

  const forcedAgain = generateModule(examplePath, { backendRoot, frontendRoot, force: true });
  assert.equal(forcedAgain.ok, true);
  const modulesPom = fs.readFileSync(path.join(backendRoot, 'ruoyi-modules/pom.xml'), 'utf8');
  const adminPom = fs.readFileSync(path.join(backendRoot, 'ruoyi-admin/pom.xml'), 'utf8');
  assert.equal(countMatches(modulesPom, /<module>ruoyi-business<\/module>/g), 1);
  assert.equal(countMatches(adminPom, /<artifactId>ruoyi-business<\/artifactId>/g), 1);
});
