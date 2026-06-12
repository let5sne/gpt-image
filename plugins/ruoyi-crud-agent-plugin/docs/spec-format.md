# Spec Format

RuoYi CRUD Agent specs are YAML or JSON documents validated by `schemas/crud-spec.schema.json`. The first supported sample is `examples/product-plan.yaml`.

Run validation before sandbox initialization or generation:

```bash
cd plugins/ruoyi-crud-agent-plugin
npm run validate
```

## Schema Overview

- `module`: names the generated module, display title, Java package, database table, and plus-ui menu path.
- `fields`: declares CRUD fields, titles, scalar type, list/form/search visibility, validation hints, enum options, and defaults.
- `permissions`: declares menu, list, create, update, delete, and export permission keys for generated backend and frontend wiring.
- `acceptance`: declares the expected backend checks, frontend checks, and report formats that verification and reporting should cover.

## Minimal Shape

```yaml
module:
  name: productPlan
  title: Product Plan
  package: org.dromara.business.product
  table: biz_product_plan
  menuPath: business/product-plan
fields:
  - name: planCode
    title: Plan Code
    type: string
    required: true
    unique: true
    list: true
    form: true
    search: true
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
    formFields:
      - planCode
  report:
    format:
      - markdown
      - json
```

Use the schema and validator output as the source of truth when a spec is rejected.
