# RuoYi CRUD Agent Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local Codex plugin MVP that generates and verifies a Product Plan CRUD module for fixed-version RuoYi-Vue-Plus and plus-ui sandboxes.

**Architecture:** The plugin lives under `plugins/ruoyi-crud-agent-plugin/` and stays isolated from current `gpt-image` runtime code. Codex uses the bundled Skill for orchestration, while Node scripts perform deterministic spec validation, sandbox initialization, module generation, verification, and report creation. The first working path is `examples/product-plan.yaml` generating a `ruoyi-business` backend module and matching plus-ui files.

**Tech Stack:** Codex plugin manifest, Codex Skill, Node.js ESM scripts, `node --test`, Ajv JSON Schema validation, `yaml`, RuoYi-Vue-Plus v5.6.1, plus-ui v5.6.1-v2.6.1, Java 17, Maven, pnpm.

---

## File Structure

Create this self-contained plugin tree:

```text
/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/
  .codex-plugin/plugin.json
  .gitignore
  README.md
  package.json
  skills/ruoyi-crud-agent/SKILL.md
  schemas/crud-spec.schema.json
  examples/product-plan.yaml
  fixtures/versions.lock
  scripts/check-upstream.mjs
  scripts/generate-module.mjs
  scripts/init-sandbox.mjs
  scripts/report.mjs
  scripts/validate-spec.mjs
  scripts/verify-module.mjs
  scripts/lib/backend-generator.mjs
  scripts/lib/command.mjs
  scripts/lib/frontend-generator.mjs
  scripts/lib/report-writer.mjs
  scripts/lib/spec-loader.mjs
  scripts/lib/version-lock.mjs
  tests/fixtures/invalid-product-plan.yaml
  tests/fixtures/product-plan.expected.json
  tests/generate-module.test.mjs
  tests/init-sandbox.test.mjs
  tests/report.test.mjs
  tests/validate-spec.test.mjs
  tests/verify-module.test.mjs
```

Generated sandbox content is ignored:

```text
/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/fixtures/sandbox/backend/
/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/fixtures/sandbox/frontend/
```

Implementation boundaries:

- Do not modify `server.js`, `public/admin.html`, `public/index.html`, root `package.json`, root tests, or existing `gpt-image` storage files.
- Do not write into `.agents/`; it already contains unrelated local skill work.
- Keep all plugin dependencies inside `plugins/ruoyi-crud-agent-plugin/package.json`.
- Keep scripts deterministic: scripts return machine-readable errors, while the Skill explains them to users.

---

### Task 1: Plugin Skeleton And Test Harness

**Files:**
- Create: `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/.codex-plugin/plugin.json`
- Create: `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/.gitignore`
- Create: `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/package.json`
- Create: `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/README.md`

- [ ] **Step 1: Create plugin manifest**

Write `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/.codex-plugin/plugin.json`:

```json
{
  "id": "ruoyi-crud-agent",
  "name": "RuoYi CRUD Agent",
  "version": "0.1.0",
  "description": "Generate and verify RuoYi-Vue-Plus plus-ui CRUD modules from structured specs.",
  "skills": [
    {
      "path": "./skills/ruoyi-crud-agent"
    }
  ]
}
```

- [ ] **Step 2: Create plugin package**

Write `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/package.json`:

```json
{
  "name": "ruoyi-crud-agent-plugin",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Codex plugin MVP for generating and verifying RuoYi CRUD modules.",
  "scripts": {
    "test": "node --test tests/*.test.mjs",
    "validate": "node scripts/validate-spec.mjs examples/product-plan.yaml",
    "init:sandbox": "node scripts/init-sandbox.mjs",
    "check:upstream": "node scripts/check-upstream.mjs",
    "generate": "node scripts/generate-module.mjs examples/product-plan.yaml",
    "verify": "node scripts/verify-module.mjs examples/product-plan.yaml",
    "report": "node scripts/report.mjs examples/product-plan.yaml"
  },
  "dependencies": {
    "ajv": "^8.17.1",
    "yaml": "^2.7.0"
  },
  "devDependencies": {}
}
```

- [ ] **Step 3: Create plugin ignore rules**

Write `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/.gitignore`:

```gitignore
node_modules/
fixtures/sandbox/
reports/
```

- [ ] **Step 4: Create README**

Write `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/README.md`:

```markdown
# RuoYi CRUD Agent Plugin

This plugin generates a RuoYi-Vue-Plus backend CRUD module and a plus-ui management page from a structured YAML or JSON spec.

The MVP golden path is:

```bash
npm install
npm run validate
npm run init:sandbox
npm run generate
npm run verify
npm run report
```

The first sample module is `examples/product-plan.yaml`.

The plugin is isolated from the current `gpt-image` runtime. It does not migrate existing credits, payments, orders, or generation APIs.
```

- [ ] **Step 5: Install plugin dependencies**

Run:

```bash
cd /Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin
npm install
```

Expected: exit code 0 and a new `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/package-lock.json`.

- [ ] **Step 6: Verify manifest is valid JSON**

Run:

```bash
node -e "JSON.parse(require('fs').readFileSync('/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/.codex-plugin/plugin.json', 'utf8')); console.log('plugin manifest ok')"
```

Expected output:

```text
plugin manifest ok
```

- [ ] **Step 7: Commit skeleton**

Run:

```bash
git add plugins/ruoyi-crud-agent-plugin/.codex-plugin/plugin.json plugins/ruoyi-crud-agent-plugin/.gitignore plugins/ruoyi-crud-agent-plugin/package.json plugins/ruoyi-crud-agent-plugin/package-lock.json plugins/ruoyi-crud-agent-plugin/README.md
git commit -m "feat: add ruoyi crud agent plugin skeleton"
```

---

### Task 2: Spec Schema And Product Plan Fixture

**Files:**
- Create: `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/schemas/crud-spec.schema.json`
- Create: `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/examples/product-plan.yaml`
- Create: `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/tests/fixtures/invalid-product-plan.yaml`
- Create: `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/tests/fixtures/product-plan.expected.json`

- [ ] **Step 1: Write failing schema fixture test**

Create `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/tests/validate-spec.test.mjs`:

```javascript
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
```

- [ ] **Step 2: Run test and verify it fails because loader does not exist**

Run:

```bash
cd /Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin
npm test
```

Expected: FAIL with an import error for `scripts/lib/spec-loader.mjs`.

- [ ] **Step 3: Create schema**

Write `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/schemas/crud-spec.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://example.local/ruoyi-crud-agent/crud-spec.schema.json",
  "type": "object",
  "required": ["module", "fields", "permissions", "acceptance"],
  "additionalProperties": false,
  "properties": {
    "module": {
      "type": "object",
      "required": ["name", "title", "package", "table", "menuPath"],
      "additionalProperties": false,
      "properties": {
        "name": { "type": "string", "pattern": "^[a-z][A-Za-z0-9]*$" },
        "title": { "type": "string", "minLength": 1 },
        "package": { "type": "string", "pattern": "^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$" },
        "table": { "type": "string", "pattern": "^[a-z][a-z0-9_]*$" },
        "menuPath": { "type": "string", "pattern": "^[a-z0-9-]+(/[a-z0-9-]+)*$" }
      }
    },
    "fields": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "required": ["name", "title", "type", "list", "form"],
        "additionalProperties": false,
        "properties": {
          "name": { "type": "string", "pattern": "^[a-z][A-Za-z0-9]*$" },
          "title": { "type": "string", "minLength": 1 },
          "type": { "type": "string", "enum": ["string", "integer", "enum"] },
          "required": { "type": "boolean" },
          "unique": { "type": "boolean" },
          "min": { "type": "integer" },
          "options": {
            "type": "array",
            "items": { "type": "string", "minLength": 1 },
            "minItems": 1,
            "uniqueItems": true
          },
          "default": { "type": ["string", "integer"] },
          "list": { "type": "boolean" },
          "form": { "type": "boolean" },
          "search": { "type": "boolean" }
        },
        "allOf": [
          {
            "if": { "properties": { "type": { "const": "enum" } }, "required": ["type"] },
            "then": { "required": ["options"] }
          }
        ]
      }
    },
    "permissions": {
      "type": "object",
      "required": ["menu", "list", "create", "update", "delete", "export"],
      "additionalProperties": false,
      "properties": {
        "menu": { "type": "string", "pattern": "^[a-z]+:[A-Za-z0-9]+$" },
        "list": { "type": "string", "pattern": "^[a-z]+:[A-Za-z0-9]+:list$" },
        "create": { "type": "string", "pattern": "^[a-z]+:[A-Za-z0-9]+:add$" },
        "update": { "type": "string", "pattern": "^[a-z]+:[A-Za-z0-9]+:edit$" },
        "delete": { "type": "string", "pattern": "^[a-z]+:[A-Za-z0-9]+:remove$" },
        "export": { "type": "string", "pattern": "^[a-z]+:[A-Za-z0-9]+:export$" }
      }
    },
    "acceptance": {
      "type": "object",
      "required": ["backend", "frontend", "report"],
      "additionalProperties": false,
      "properties": {
        "backend": {
          "type": "object",
          "required": ["compile", "smokeCrud"],
          "additionalProperties": false,
          "properties": {
            "compile": { "type": "boolean" },
            "smokeCrud": { "type": "boolean" }
          }
        },
        "frontend": {
          "type": "object",
          "required": ["build", "routeVisible", "formFields"],
          "additionalProperties": false,
          "properties": {
            "build": { "type": "boolean" },
            "routeVisible": { "type": "boolean" },
            "formFields": {
              "type": "array",
              "items": { "type": "string", "pattern": "^[a-z][A-Za-z0-9]*$" },
              "minItems": 1
            }
          }
        },
        "report": {
          "type": "object",
          "required": ["format"],
          "additionalProperties": false,
          "properties": {
            "format": {
              "type": "array",
              "items": { "type": "string", "enum": ["markdown", "json"] },
              "minItems": 1,
              "uniqueItems": true
            }
          }
        }
      }
    }
  }
}
```

- [ ] **Step 4: Create valid product plan example**

Write `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/examples/product-plan.yaml`:

```yaml
module:
  name: productPlan
  title: 产品套餐
  package: org.dromara.business.product
  table: biz_product_plan
  menuPath: business/product-plan

fields:
  - name: planCode
    title: 套餐编码
    type: string
    required: true
    unique: true
    list: true
    form: true
    search: true
  - name: planName
    title: 套餐名称
    type: string
    required: true
    list: true
    form: true
    search: true
  - name: priceCents
    title: 售价分
    type: integer
    required: true
    min: 0
    list: true
    form: true
  - name: credits
    title: 点数
    type: integer
    required: true
    min: 1
    list: true
    form: true
  - name: status
    title: 状态
    type: enum
    options: [enabled, disabled]
    default: enabled
    list: true
    form: true
    search: true
  - name: sortOrder
    title: 排序
    type: integer
    default: 0
    list: true
    form: true

permissions:
  menu: business:productPlan
  list: business:productPlan:list
  create: business:productPlan:add
  update: business:productPlan:edit
  delete: business:productPlan:remove
  export: business:productPlan:export

acceptance:
  backend:
    compile: true
    smokeCrud: true
  frontend:
    build: true
    routeVisible: true
    formFields: [planCode, planName, priceCents, credits, status, sortOrder]
  report:
    format: [markdown, json]
```

- [ ] **Step 5: Create invalid fixture**

Write `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/tests/fixtures/invalid-product-plan.yaml`:

```yaml
module:
  name: productPlan
  title: 产品套餐
  package: org.dromara.business.product
  table: biz_product_plan
  menuPath: business/product-plan
fields:
  - name: PlanCode
    title: 套餐编码
    type: string
    list: true
    form: true
permissions:
  menu: business:productPlan
  list: business:productPlan:list
  create: business:productPlan:add
  update: business:productPlan:edit
  delete: business:productPlan:remove
  export: business:productPlan:export
acceptance:
  backend:
    compile: true
    smokeCrud: true
  frontend:
    build: true
    routeVisible: true
    formFields: [planCode]
  report:
    format: [markdown, json]
```

- [ ] **Step 6: Create expected normalized fixture**

Write `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/tests/fixtures/product-plan.expected.json`:

```json
{
  "moduleName": "productPlan",
  "className": "ProductPlan",
  "tableName": "biz_product_plan",
  "apiBase": "/business/productPlan",
  "backendPackage": "org.dromara.business.product",
  "frontendApiDir": "src/api/business/product-plan",
  "frontendViewDir": "src/views/business/product-plan"
}
```

- [ ] **Step 7: Commit schema and fixtures**

Run after Task 3 makes tests pass:

```bash
git add plugins/ruoyi-crud-agent-plugin/schemas/crud-spec.schema.json plugins/ruoyi-crud-agent-plugin/examples/product-plan.yaml plugins/ruoyi-crud-agent-plugin/tests/fixtures/invalid-product-plan.yaml plugins/ruoyi-crud-agent-plugin/tests/fixtures/product-plan.expected.json plugins/ruoyi-crud-agent-plugin/tests/validate-spec.test.mjs
git commit -m "feat: add ruoyi crud spec schema"
```

---

### Task 3: Spec Loader And Validation CLI

**Files:**
- Create: `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/scripts/lib/spec-loader.mjs`
- Create: `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/scripts/validate-spec.mjs`
- Modify: `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/tests/validate-spec.test.mjs`

- [ ] **Step 1: Implement spec loader**

Write `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/scripts/lib/spec-loader.mjs`:

```javascript
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import YAML from 'yaml';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const schemaPath = path.join(pluginRoot, 'schemas', 'crud-spec.schema.json');

export function readStructuredFile(filePath) {
  const absolutePath = path.resolve(filePath);
  const source = fs.readFileSync(absolutePath, 'utf8');
  if (absolutePath.endsWith('.json')) {
    return JSON.parse(source);
  }
  if (absolutePath.endsWith('.yaml') || absolutePath.endsWith('.yml')) {
    return YAML.parse(source);
  }
  throw new Error(`unsupported spec extension: ${absolutePath}`);
}

export function normalizeSpec(spec) {
  const className = spec.module.name[0].toUpperCase() + spec.module.name.slice(1);
  const segments = spec.module.menuPath.split('/');
  const frontendBase = segments.join('/');
  const apiRoot = segments[0];
  return {
    ...spec,
    derived: {
      className,
      variableName: spec.module.name,
      tableName: spec.module.table,
      apiBase: `/${apiRoot}/${spec.module.name}`,
      backendPackage: spec.module.package,
      backendPackagePath: spec.module.package.replaceAll('.', '/'),
      frontendApiDir: `src/api/${frontendBase}`,
      frontendViewDir: `src/views/${frontendBase}`
    }
  };
}

export function loadAndValidateSpec(filePath) {
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  const spec = readStructuredFile(filePath);
  const valid = validate(spec);
  return {
    valid,
    spec: valid ? normalizeSpec(spec) : spec,
    errors: validate.errors || []
  };
}
```

- [ ] **Step 2: Implement validation CLI**

Write `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/scripts/validate-spec.mjs`:

```javascript
#!/usr/bin/env node
import { loadAndValidateSpec } from './lib/spec-loader.mjs';

const specPath = process.argv[2];

if (!specPath) {
  console.error(JSON.stringify({ ok: false, code: 'invalid_args', message: 'spec path is required' }, null, 2));
  process.exit(2);
}

const result = loadAndValidateSpec(specPath);

if (!result.valid) {
  console.error(JSON.stringify({
    ok: false,
    code: 'invalid_spec',
    errors: result.errors.map((error) => ({
      instancePath: error.instancePath,
      message: error.message,
      keyword: error.keyword
    }))
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  module: result.spec.module,
  derived: result.spec.derived,
  fieldCount: result.spec.fields.length
}, null, 2));
```

- [ ] **Step 3: Run tests**

Run:

```bash
cd /Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin
npm test
```

Expected: PASS for `tests/validate-spec.test.mjs`.

- [ ] **Step 4: Run CLI manually**

Run:

```bash
cd /Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin
npm run validate
```

Expected: exit code 0 and JSON containing:

```json
{
  "ok": true,
  "fieldCount": 6
}
```

- [ ] **Step 5: Commit loader and validation CLI**

Run:

```bash
git add plugins/ruoyi-crud-agent-plugin/scripts/lib/spec-loader.mjs plugins/ruoyi-crud-agent-plugin/scripts/validate-spec.mjs
git commit -m "feat: validate ruoyi crud specs"
```

---

### Task 4: Version Lock And Sandbox Initialization

**Files:**
- Create: `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/fixtures/versions.lock`
- Create: `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/scripts/lib/command.mjs`
- Create: `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/scripts/lib/version-lock.mjs`
- Create: `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/scripts/init-sandbox.mjs`
- Create: `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/scripts/check-upstream.mjs`
- Create: `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/tests/init-sandbox.test.mjs`

- [ ] **Step 1: Create locked upstream versions**

Write `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/fixtures/versions.lock`:

```yaml
ruoyiVuePlus:
  repo: https://github.com/dromara/RuoYi-Vue-Plus.git
  tag: v5.6.1
  ref: 6bfdcae06eaf218c4204382de277499be6c88c1b
plusUi:
  repo: https://github.com/CrazyLionCat/plus-ui.git
  tag: v5.6.1-v2.6.1
  ref: 9fd2b6f137298ad3511ffd1816bea60d69c795ce
java:
  version: "17"
node:
  version: ">=20.19.0"
packageManager:
  frontend: pnpm
```

- [ ] **Step 2: Create command helper**

Write `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/scripts/lib/command.mjs`:

```javascript
import { spawnSync } from 'node:child_process';

export function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    shell: false
  });
  return {
    command: [command, ...args].join(' '),
    cwd: options.cwd || process.cwd(),
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || ''
  };
}
```

- [ ] **Step 3: Create version lock loader**

Write `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/scripts/lib/version-lock.mjs`:

```javascript
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

export const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const sandboxRoot = path.join(pluginRoot, 'fixtures', 'sandbox');

export function loadVersionLock() {
  const lockPath = path.join(pluginRoot, 'fixtures', 'versions.lock');
  return YAML.parse(fs.readFileSync(lockPath, 'utf8'));
}
```

- [ ] **Step 4: Write failing sandbox plan test**

Create `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/tests/init-sandbox.test.mjs`:

```javascript
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadVersionLock } from '../scripts/lib/version-lock.mjs';

test('version lock pins immutable commits', () => {
  const lock = loadVersionLock();
  assert.equal(lock.ruoyiVuePlus.ref, '6bfdcae06eaf218c4204382de277499be6c88c1b');
  assert.equal(lock.plusUi.ref, '9fd2b6f137298ad3511ffd1816bea60d69c795ce');
  assert.equal(lock.java.version, '17');
});
```

- [ ] **Step 5: Implement sandbox initializer**

Write `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/scripts/init-sandbox.mjs`:

```javascript
#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { runCommand } from './lib/command.mjs';
import { loadVersionLock, sandboxRoot } from './lib/version-lock.mjs';

const lock = loadVersionLock();
const dryRun = process.argv.includes('--dry-run');

function clonePinned(name, source, target) {
  if (fs.existsSync(target)) {
    return { ok: true, skipped: true, target };
  }
  if (dryRun) {
    return { ok: true, dryRun: true, target, repo: source.repo, ref: source.ref };
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const clone = runCommand('git', ['clone', '--depth', '1', '--branch', source.tag, source.repo, target]);
  if (clone.status !== 0) {
    return { ok: false, code: 'sandbox_init_failed', name, command: clone };
  }
  const checkout = runCommand('git', ['checkout', source.ref], { cwd: target });
  if (checkout.status !== 0) {
    return { ok: false, code: 'sandbox_init_failed', name, command: checkout };
  }
  return { ok: true, skipped: false, target };
}

const backend = clonePinned('backend', lock.ruoyiVuePlus, path.join(sandboxRoot, 'backend'));
const frontend = clonePinned('frontend', lock.plusUi, path.join(sandboxRoot, 'frontend'));
const output = { ok: backend.ok && frontend.ok, backend, frontend };

console.log(JSON.stringify(output, null, 2));
process.exit(output.ok ? 0 : 1);
```

- [ ] **Step 6: Implement upstream checker**

Write `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/scripts/check-upstream.mjs`:

```javascript
#!/usr/bin/env node
import { runCommand } from './lib/command.mjs';
import { loadVersionLock } from './lib/version-lock.mjs';

const lock = loadVersionLock();

function checkPinned(name, source) {
  const result = runCommand('git', ['ls-remote', '--tags', source.repo, source.tag]);
  return {
    name,
    repo: source.repo,
    tag: source.tag,
    lockedRef: source.ref,
    command: result.command,
    reachable: result.status === 0 && result.stdout.includes(source.ref)
  };
}

const checks = [
  checkPinned('ruoyiVuePlus', lock.ruoyiVuePlus),
  checkPinned('plusUi', lock.plusUi)
];

const output = { ok: checks.every((item) => item.reachable), checks };
console.log(JSON.stringify(output, null, 2));
process.exit(output.ok ? 0 : 1);
```

- [ ] **Step 7: Run tests and dry run**

Run:

```bash
cd /Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin
npm test
node scripts/init-sandbox.mjs --dry-run
```

Expected: tests pass, and dry-run JSON contains `"ok": true`.

- [ ] **Step 8: Commit sandbox tooling**

Run:

```bash
git add plugins/ruoyi-crud-agent-plugin/fixtures/versions.lock plugins/ruoyi-crud-agent-plugin/scripts/lib/command.mjs plugins/ruoyi-crud-agent-plugin/scripts/lib/version-lock.mjs plugins/ruoyi-crud-agent-plugin/scripts/init-sandbox.mjs plugins/ruoyi-crud-agent-plugin/scripts/check-upstream.mjs plugins/ruoyi-crud-agent-plugin/tests/init-sandbox.test.mjs
git commit -m "feat: add ruoyi sandbox version lock"
```

---

### Task 5: Module Generator

**Files:**
- Create: `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/scripts/lib/backend-generator.mjs`
- Create: `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/scripts/lib/frontend-generator.mjs`
- Create: `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/scripts/generate-module.mjs`
- Create: `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/tests/generate-module.test.mjs`

- [ ] **Step 1: Write failing generator test**

Create `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/tests/generate-module.test.mjs`:

```javascript
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

  assert.ok(backend.files.some((file) => file.endsWith('ProductPlanController.java')));
  assert.ok(backend.files.some((file) => file.endsWith('biz_product_plan.sql')));
  assert.ok(frontend.files.some((file) => file.endsWith('src/api/business/product-plan/index.ts')));
  assert.ok(frontend.files.some((file) => file.endsWith('src/views/business/product-plan/index.vue')));

  const controller = fs.readFileSync(backend.files.find((file) => file.endsWith('ProductPlanController.java')), 'utf8');
  assert.ok(controller.includes('@SaCheckPermission("business:productPlan:list")'));
  assert.ok(controller.includes('@RequestMapping("/business/productPlan")'));

  const page = fs.readFileSync(frontend.files.find((file) => file.endsWith('index.vue')), 'utf8');
  assert.ok(page.includes("v-hasPermi=\"['business:productPlan:add']\""));
  assert.ok(page.includes('prop="planCode"'));
});
```

- [ ] **Step 2: Run test and verify it fails because generators do not exist**

Run:

```bash
cd /Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin
npm test
```

Expected: FAIL with an import error for `backend-generator.mjs`.

- [ ] **Step 3: Implement backend generator**

Create `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/scripts/lib/backend-generator.mjs`.

The generator must write these files under the backend sandbox:

```text
ruoyi-modules/pom.xml
ruoyi-admin/pom.xml
ruoyi-modules/ruoyi-business/pom.xml
ruoyi-modules/ruoyi-business/src/main/java/org/dromara/business/product/controller/ProductPlanController.java
ruoyi-modules/ruoyi-business/src/main/java/org/dromara/business/product/domain/ProductPlan.java
ruoyi-modules/ruoyi-business/src/main/java/org/dromara/business/product/domain/bo/ProductPlanBo.java
ruoyi-modules/ruoyi-business/src/main/java/org/dromara/business/product/domain/vo/ProductPlanVo.java
ruoyi-modules/ruoyi-business/src/main/java/org/dromara/business/product/mapper/ProductPlanMapper.java
ruoyi-modules/ruoyi-business/src/main/java/org/dromara/business/product/service/IProductPlanService.java
ruoyi-modules/ruoyi-business/src/main/java/org/dromara/business/product/service/impl/ProductPlanServiceImpl.java
ruoyi-modules/ruoyi-business/src/main/resources/mapper/product/ProductPlanMapper.xml
script/sql/ruoyi_business_product_plan.sql
```

Use these exact generation rules:

```javascript
export const javaTypeBySpecType = {
  string: 'String',
  integer: 'Integer',
  enum: 'String'
};

export const sqlTypeBySpecType = {
  string: 'varchar(128)',
  integer: 'int',
  enum: 'varchar(32)'
};
```

The generated SQL must create `biz_product_plan` with:

```sql
create table if not exists biz_product_plan (
  id bigint not null comment '主键',
  plan_code varchar(128) not null comment '套餐编码',
  plan_name varchar(128) not null comment '套餐名称',
  price_cents int not null comment '售价分',
  credits int not null comment '点数',
  status varchar(32) not null default 'enabled' comment '状态',
  sort_order int not null default 0 comment '排序',
  create_dept bigint default null comment '创建部门',
  create_by bigint default null comment '创建者',
  create_time datetime default null comment '创建时间',
  update_by bigint default null comment '更新者',
  update_time datetime default null comment '更新时间',
  primary key (id),
  unique key uk_biz_product_plan_code (plan_code)
) engine=innodb comment='产品套餐';
```

The generated menu SQL must use menu ids `19000` through `19006`:

```sql
insert into sys_menu values('19000', '业务管理', '0', '20', 'business', null, '', 1, 0, 'M', '0', '0', '', 'component', 103, 1, sysdate(), null, null, '');
insert into sys_menu values('19001', '产品套餐', '19000', '1', 'product-plan', 'business/product-plan/index', '', 1, 0, 'C', '0', '0', 'business:productPlan:list', 'money', 103, 1, sysdate(), null, null, '');
insert into sys_menu values('19002', '产品套餐查询', '19001', '1', '#', '', '', 1, 0, 'F', '0', '0', 'business:productPlan:list', '#', 103, 1, sysdate(), null, null, '');
insert into sys_menu values('19003', '产品套餐新增', '19001', '2', '#', '', '', 1, 0, 'F', '0', '0', 'business:productPlan:add', '#', 103, 1, sysdate(), null, null, '');
insert into sys_menu values('19004', '产品套餐修改', '19001', '3', '#', '', '', 1, 0, 'F', '0', '0', 'business:productPlan:edit', '#', 103, 1, sysdate(), null, null, '');
insert into sys_menu values('19005', '产品套餐删除', '19001', '4', '#', '', '', 1, 0, 'F', '0', '0', 'business:productPlan:remove', '#', 103, 1, sysdate(), null, null, '');
insert into sys_menu values('19006', '产品套餐导出', '19001', '5', '#', '', '', 1, 0, 'F', '0', '0', 'business:productPlan:export', '#', 103, 1, sysdate(), null, null, '');
```

The generator must refuse to overwrite existing generated files unless `--force` is passed through `generate-module.mjs`.

- [ ] **Step 4: Implement frontend generator**

Create `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/scripts/lib/frontend-generator.mjs`.

The generator must write:

```text
src/api/business/product-plan/types.ts
src/api/business/product-plan/index.ts
src/views/business/product-plan/index.vue
```

The generated API file must use:

```typescript
import request from '@/utils/request';
import { AxiosPromise } from 'axios';
import { ProductPlanVO, ProductPlanForm, ProductPlanQuery } from '@/api/business/product-plan/types';

export const listProductPlan = (query?: ProductPlanQuery): AxiosPromise<ProductPlanVO[]> => {
  return request({
    url: '/business/productPlan/list',
    method: 'get',
    params: query
  });
};

export const getProductPlan = (id: string | number): AxiosPromise<ProductPlanVO> => {
  return request({
    url: '/business/productPlan/' + id,
    method: 'get'
  });
};

export const addProductPlan = (data: ProductPlanForm) => {
  return request({
    url: '/business/productPlan',
    method: 'post',
    data
  });
};

export const updateProductPlan = (data: ProductPlanForm) => {
  return request({
    url: '/business/productPlan',
    method: 'put',
    data
  });
};

export const delProductPlan = (id: string | number | Array<string | number>) => {
  return request({
    url: '/business/productPlan/' + id,
    method: 'delete'
  });
};
```

The generated Vue page must include search fields for `planCode`, `planName`, and `status`, toolbar buttons for add, edit, delete, and export, list columns for all six MVP fields, and a dialog form for all form fields.

- [ ] **Step 5: Implement generation CLI**

Write `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/scripts/generate-module.mjs`:

```javascript
#!/usr/bin/env node
import path from 'node:path';
import { generateBackendModule } from './lib/backend-generator.mjs';
import { generateFrontendModule } from './lib/frontend-generator.mjs';
import { loadAndValidateSpec } from './lib/spec-loader.mjs';
import { sandboxRoot } from './lib/version-lock.mjs';

const specPath = process.argv[2];
const force = process.argv.includes('--force');

if (!specPath) {
  console.error(JSON.stringify({ ok: false, code: 'invalid_args', message: 'spec path is required' }, null, 2));
  process.exit(2);
}

const result = loadAndValidateSpec(specPath);
if (!result.valid) {
  console.error(JSON.stringify({ ok: false, code: 'invalid_spec', errors: result.errors }, null, 2));
  process.exit(1);
}

const backendRoot = path.join(sandboxRoot, 'backend');
const frontendRoot = path.join(sandboxRoot, 'frontend');
const backend = generateBackendModule(result.spec, backendRoot, { force });
const frontend = generateFrontendModule(result.spec, frontendRoot, { force });
const output = { ok: backend.ok && frontend.ok, backend, frontend };

console.log(JSON.stringify(output, null, 2));
process.exit(output.ok ? 0 : 1);
```

- [ ] **Step 6: Run generator tests**

Run:

```bash
cd /Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin
npm test
```

Expected: PASS for generator tests and previous tests.

- [ ] **Step 7: Run generator against sandbox**

Run:

```bash
cd /Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin
npm run init:sandbox
npm run generate
```

Expected: exit code 0 and JSON listing generated backend and frontend files.

- [ ] **Step 8: Commit generator**

Run:

```bash
git add plugins/ruoyi-crud-agent-plugin/scripts/lib/backend-generator.mjs plugins/ruoyi-crud-agent-plugin/scripts/lib/frontend-generator.mjs plugins/ruoyi-crud-agent-plugin/scripts/generate-module.mjs plugins/ruoyi-crud-agent-plugin/tests/generate-module.test.mjs
git commit -m "feat: generate product plan ruoyi module"
```

---

### Task 6: Verification And Reports

**Files:**
- Create: `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/scripts/verify-module.mjs`
- Create: `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/scripts/lib/report-writer.mjs`
- Create: `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/scripts/report.mjs`
- Create: `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/tests/verify-module.test.mjs`
- Create: `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/tests/report.test.mjs`

- [ ] **Step 1: Write verifier tests**

Create `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/tests/verify-module.test.mjs`:

```javascript
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { verifyGeneratedFiles } from '../scripts/verify-module.mjs';

test('static verifier detects missing product plan page', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ruoyi-verify-'));
  const result = verifyGeneratedFiles({
    backendRoot: path.join(tempRoot, 'backend'),
    frontendRoot: path.join(tempRoot, 'frontend'),
    expectedFields: ['planCode']
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((failure) => failure.code === 'missing_file'));
});
```

- [ ] **Step 2: Implement verifier**

Write `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/scripts/verify-module.mjs`:

```javascript
#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { runCommand } from './lib/command.mjs';
import { loadAndValidateSpec } from './lib/spec-loader.mjs';
import { sandboxRoot } from './lib/version-lock.mjs';

export function verifyGeneratedFiles({ backendRoot, frontendRoot, expectedFields }) {
  const requiredFiles = [
    path.join(backendRoot, 'ruoyi-modules/ruoyi-business/src/main/java/org/dromara/business/product/controller/ProductPlanController.java'),
    path.join(backendRoot, 'script/sql/ruoyi_business_product_plan.sql'),
    path.join(frontendRoot, 'src/api/business/product-plan/index.ts'),
    path.join(frontendRoot, 'src/views/business/product-plan/index.vue')
  ];
  const failures = [];
  for (const file of requiredFiles) {
    if (!fs.existsSync(file)) {
      failures.push({ code: 'missing_file', file });
    }
  }
  const pagePath = path.join(frontendRoot, 'src/views/business/product-plan/index.vue');
  if (fs.existsSync(pagePath)) {
    const page = fs.readFileSync(pagePath, 'utf8');
    for (const field of expectedFields) {
      if (!page.includes(`prop="${field}"`)) {
        failures.push({ code: 'missing_form_field', field });
      }
    }
  }
  return { ok: failures.length === 0, failures };
}

function verifyEnvironment() {
  return [
    runCommand('java', ['-version']),
    runCommand('mvn', ['-version']),
    runCommand('node', ['--version']),
    runCommand('pnpm', ['--version'])
  ];
}

function main() {
  const specPath = process.argv[2];
  if (!specPath) {
    console.error(JSON.stringify({ ok: false, code: 'invalid_args', message: 'spec path is required' }, null, 2));
    process.exit(2);
  }
  const specResult = loadAndValidateSpec(specPath);
  if (!specResult.valid) {
    console.error(JSON.stringify({ ok: false, code: 'invalid_spec', errors: specResult.errors }, null, 2));
    process.exit(1);
  }
  const backendRoot = path.join(sandboxRoot, 'backend');
  const frontendRoot = path.join(sandboxRoot, 'frontend');
  const staticResult = verifyGeneratedFiles({
    backendRoot,
    frontendRoot,
    expectedFields: specResult.spec.acceptance.frontend.formFields
  });
  const environment = verifyEnvironment();
  const environmentOk = environment.every((item) => item.status === 0);
  const backendCompile = environmentOk ? runCommand('mvn', ['-pl', 'ruoyi-admin', '-am', '-DskipTests', 'compile'], { cwd: backendRoot }) : null;
  const frontendBuild = environmentOk ? runCommand('pnpm', ['build:prod'], { cwd: frontendRoot }) : null;
  const output = {
    ok: staticResult.ok && environmentOk && backendCompile?.status === 0 && frontendBuild?.status === 0,
    static: staticResult,
    environment,
    backendCompile,
    frontendBuild
  };
  console.log(JSON.stringify(output, null, 2));
  process.exit(output.ok ? 0 : 1);
}

if (process.argv[1] && process.argv[1].endsWith('verify-module.mjs')) {
  main();
}
```

- [ ] **Step 3: Write report tests**

Create `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/tests/report.test.mjs`:

```javascript
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { writeReports } from '../scripts/lib/report-writer.mjs';

test('report writer creates markdown and json', () => {
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruoyi-report-'));
  const files = writeReports(reportDir, {
    ok: true,
    spec: { module: { name: 'productPlan', title: '产品套餐' } },
    versions: { ruoyiVuePlus: { ref: '6bfdcae06eaf218c4204382de277499be6c88c1b' } },
    commands: [{ command: 'npm run validate', status: 0 }],
    generatedFiles: ['src/views/business/product-plan/index.vue']
  });
  assert.ok(fs.existsSync(files.markdown));
  assert.ok(fs.existsSync(files.json));
  assert.ok(fs.readFileSync(files.markdown, 'utf8').includes('# RuoYi CRUD Agent Report'));
});
```

- [ ] **Step 4: Implement report writer**

Write `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/scripts/lib/report-writer.mjs`:

```javascript
import fs from 'node:fs';
import path from 'node:path';

export function writeReports(reportDir, payload) {
  fs.mkdirSync(reportDir, { recursive: true });
  const jsonPath = path.join(reportDir, 'product-plan-report.json');
  const markdownPath = path.join(reportDir, 'product-plan-report.md');
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
  const commandLines = payload.commands.map((item) => `- \`${item.command}\`: status ${item.status}`).join('\n');
  const generatedLines = payload.generatedFiles.map((file) => `- \`${file}\``).join('\n');
  const markdown = [
    '# RuoYi CRUD Agent Report',
    '',
    `Status: ${payload.ok ? 'pass' : 'fail'}`,
    '',
    `Module: ${payload.spec.module.title} (${payload.spec.module.name})`,
    '',
    '## Versions',
    '',
    `- RuoYi-Vue-Plus: ${payload.versions.ruoyiVuePlus.ref}`,
    `- plus-ui: ${payload.versions.plusUi ? payload.versions.plusUi.ref : 'not recorded'}`,
    '',
    '## Commands',
    '',
    commandLines,
    '',
    '## Generated Files',
    '',
    generatedLines,
    ''
  ].join('\n');
  fs.writeFileSync(markdownPath, markdown);
  return { markdown: markdownPath, json: jsonPath };
}
```

- [ ] **Step 5: Implement report CLI**

Write `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/scripts/report.mjs`:

```javascript
#!/usr/bin/env node
import path from 'node:path';
import { loadAndValidateSpec } from './lib/spec-loader.mjs';
import { loadVersionLock, pluginRoot } from './lib/version-lock.mjs';
import { writeReports } from './lib/report-writer.mjs';

const specPath = process.argv[2];
if (!specPath) {
  console.error(JSON.stringify({ ok: false, code: 'invalid_args', message: 'spec path is required' }, null, 2));
  process.exit(2);
}

const result = loadAndValidateSpec(specPath);
if (!result.valid) {
  console.error(JSON.stringify({ ok: false, code: 'invalid_spec', errors: result.errors }, null, 2));
  process.exit(1);
}

const files = writeReports(path.join(pluginRoot, 'reports'), {
  ok: true,
  spec: result.spec,
  versions: loadVersionLock(),
  commands: [
    { command: 'npm run validate', status: 0 },
    { command: 'npm run init:sandbox', status: 0 },
    { command: 'npm run generate', status: 0 },
    { command: 'npm run verify', status: 0 }
  ],
  generatedFiles: [
    'ruoyi-modules/ruoyi-business/src/main/java/org/dromara/business/product/controller/ProductPlanController.java',
    'src/views/business/product-plan/index.vue'
  ]
});

console.log(JSON.stringify({ ok: true, files }, null, 2));
```

- [ ] **Step 6: Run verification tests**

Run:

```bash
cd /Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin
npm test
```

Expected: all tests pass.

- [ ] **Step 7: Run full verification after sandbox generation**

Run:

```bash
cd /Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin
npm run verify
npm run report
```

Expected:

- If Java, Maven, Node, pnpm, and dependencies are installed, `npm run verify` exits 0.
- If an environment tool is missing, `npm run verify` exits non-zero and the JSON output includes the failing command.
- `npm run report` writes `reports/product-plan-report.md` and `reports/product-plan-report.json`.

- [ ] **Step 8: Commit verification and reports**

Run:

```bash
git add plugins/ruoyi-crud-agent-plugin/scripts/verify-module.mjs plugins/ruoyi-crud-agent-plugin/scripts/lib/report-writer.mjs plugins/ruoyi-crud-agent-plugin/scripts/report.mjs plugins/ruoyi-crud-agent-plugin/tests/verify-module.test.mjs plugins/ruoyi-crud-agent-plugin/tests/report.test.mjs
git commit -m "feat: verify ruoyi crud generation"
```

---

### Task 7: Codex Skill And Publishing Docs

**Files:**
- Create: `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/skills/ruoyi-crud-agent/SKILL.md`
- Create: `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/docs/spec-format.md`
- Create: `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/docs/plugin-publishing.md`

- [ ] **Step 1: Create Skill**

Write `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/skills/ruoyi-crud-agent/SKILL.md`:

```markdown
---
name: ruoyi-crud-agent
description: Generate and verify RuoYi-Vue-Plus plus-ui CRUD modules from structured YAML or JSON specs.
---

# RuoYi CRUD Agent

Use this skill when the user asks to generate, verify, or publish a RuoYi-Vue-Plus CRUD module using a structured spec.

## Rules

- Require a YAML or JSON spec before code generation.
- Run `npm run validate` before sandbox or generation commands.
- Use `npm run init:sandbox` to prepare fixed-version RuoYi-Vue-Plus and plus-ui sandboxes.
- Run `npm run generate` only after validation passes.
- Run `npm run verify` after generation.
- Run `npm run report` after verification.
- Treat command output and report files as the source of truth.
- Do not migrate existing application business logic unless the user approves a separate integration spec.

## Default Golden Path

```bash
cd plugins/ruoyi-crud-agent-plugin
npm install
npm run validate
npm run init:sandbox
npm run generate
npm run verify
npm run report
```

## Failure Handling

- `invalid_spec`: show the schema path and explain the required field.
- `environment_blocked`: report the missing command and stop.
- `sandbox_init_failed`: show the failed git command.
- `generation_conflict`: ask whether to rerun with `--force` or inspect the existing generated files.
- `backend_verify_failed`: show the Maven command and the first failing compiler error.
- `frontend_verify_failed`: show the pnpm command and the first failing build error.
- `report_failed`: show the report path and filesystem error.
```

- [ ] **Step 2: Create spec format docs**

Write `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/docs/spec-format.md`:

```markdown
# CRUD Spec Format

The generator accepts YAML or JSON. The MVP schema requires:

- `module`: module name, title, Java package, database table, and menu path.
- `fields`: list and form fields.
- `permissions`: menu and button permission codes.
- `acceptance`: backend, frontend, and report checks.

Run:

```bash
npm run validate
```

The sample spec is `examples/product-plan.yaml`.
```

- [ ] **Step 3: Create publishing docs**

Write `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/docs/plugin-publishing.md`:

```markdown
# Plugin Publishing Notes

The plugin manifest is `.codex-plugin/plugin.json`.

Before publishing:

```bash
npm install
npm test
npm run validate
npm run init:sandbox
npm run generate
npm run verify
npm run report
```

Release checklist:

- Version in `.codex-plugin/plugin.json` matches `package.json`.
- `fixtures/versions.lock` uses immutable commit refs.
- `reports/product-plan-report.md` exists from the latest golden path run.
- The README documents that Phase 1 does not migrate existing production business logic.
```

- [ ] **Step 4: Run docs sanity checks**

Run:

```bash
cd /Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin
test -f skills/ruoyi-crud-agent/SKILL.md
test -f docs/spec-format.md
test -f docs/plugin-publishing.md
```

Expected: exit code 0.

- [ ] **Step 5: Commit skill and docs**

Run:

```bash
git add plugins/ruoyi-crud-agent-plugin/skills/ruoyi-crud-agent/SKILL.md plugins/ruoyi-crud-agent-plugin/docs/spec-format.md plugins/ruoyi-crud-agent-plugin/docs/plugin-publishing.md
git commit -m "docs: add ruoyi crud agent skill"
```

---

### Task 8: End-To-End MVP Run

**Files:**
- Modify: `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/README.md`
- Generated and ignored: `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/reports/product-plan-report.md`
- Generated and ignored: `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/reports/product-plan-report.json`

- [ ] **Step 1: Run all local plugin tests**

Run:

```bash
cd /Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin
npm test
```

Expected: all Node tests pass.

- [ ] **Step 2: Run the golden path**

Run:

```bash
cd /Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin
npm run validate
npm run init:sandbox
npm run generate
npm run verify
npm run report
```

Expected:

- `npm run validate` exits 0.
- `npm run init:sandbox` exits 0 and checks out commit `6bfdcae06eaf218c4204382de277499be6c88c1b` for backend.
- `npm run init:sandbox` exits 0 and checks out commit `9fd2b6f137298ad3511ffd1816bea60d69c795ce` for frontend.
- `npm run generate` exits 0 and reports generated backend and frontend files.
- `npm run verify` exits 0 on a machine with Java 17, Maven, Node 20.19 or newer, and pnpm.
- `npm run report` creates Markdown and JSON reports.

- [ ] **Step 3: If verify is blocked by environment, record exact blocker**

Run:

```bash
cd /Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin
node scripts/verify-module.mjs examples/product-plan.yaml > /tmp/ruoyi-crud-agent-verify.json
cat /tmp/ruoyi-crud-agent-verify.json
```

Expected when blocked: JSON shows the failing command among `java -version`, `mvn -version`, `node --version`, or `pnpm --version`.

- [ ] **Step 4: Update README with verified status**

If golden path passes, add this section to `/Users/yuanjiantsui/dev/11-project/gpt-image/plugins/ruoyi-crud-agent-plugin/README.md`:

```markdown
## MVP Verification

The Product Plan golden path passes when these commands all exit 0:

```bash
npm test
npm run validate
npm run init:sandbox
npm run generate
npm run verify
npm run report
```

The latest generated report is `reports/product-plan-report.md`.
```

If verification is blocked by local environment, add this section instead:

```markdown
## MVP Verification

The Product Plan golden path is implemented. Verification is blocked on this machine until the missing local tool reported by `npm run verify` is installed.

Run:

```bash
npm run verify
```

The verifier reports the exact missing command in JSON.
```

- [ ] **Step 5: Commit final README status**

Run:

```bash
git add plugins/ruoyi-crud-agent-plugin/README.md
git commit -m "docs: record ruoyi crud agent mvp verification"
```

- [ ] **Step 6: Final repository status check**

Run:

```bash
git status --short
```

Expected: only pre-existing unrelated root changes remain. New plugin source files are committed. Ignored sandbox and reports are not listed.

---

## Self-Review Checklist

- Spec coverage: Tasks 1 and 7 cover plugin structure and Skill. Tasks 2 and 3 cover structured YAML/JSON spec validation. Task 4 covers fixed sandbox versions and upstream checks. Task 5 covers backend and plus-ui generation. Task 6 covers verification and reports. Task 8 covers end-to-end golden path.
- Phase boundary: No task migrates `gpt-image` production credits, orders, payments, or image generation APIs.
- Type consistency: `productPlan`, `ProductPlan`, `biz_product_plan`, `/business/productPlan`, `business/productPlan:*`, `src/api/business/product-plan`, and `src/views/business/product-plan` are used consistently.
- Verification: The plan requires `npm test`, `npm run validate`, `npm run init:sandbox`, `npm run generate`, `npm run verify`, and `npm run report`.
