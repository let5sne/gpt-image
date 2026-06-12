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

`npm run verify` is the verification gate. It checks static generated files, local Java/Maven/Node/pnpm availability, backend Maven compile, frontend dependency install, and frontend production build.

The latest generated report is `reports/ruoyi-crud-agent-report.md`.
