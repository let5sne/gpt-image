---
name: ruoyi-crud-agent
description: Generate and verify RuoYi-Vue-Plus plus-ui CRUD modules from structured YAML or JSON specs.
---

# RuoYi CRUD Agent

Use this skill when the user asks to generate, verify, or publish a RuoYi-Vue-Plus CRUD module with a plus-ui frontend from a structured spec.

## Rules

- Require a YAML or JSON CRUD spec before generation or verification.
- Run `npm run validate` before `npm run init:sandbox` or `npm run generate`.
- Use `npm run init:sandbox` to prepare fixed RuoYi-Vue-Plus and plus-ui versions from the plugin lock files.
- Run `npm run generate` only after validation succeeds.
- Run `npm run verify` after generation.
- Run `npm run report` after verification to write summary artifacts.
- Treat `npm run verify` exit status and output as the verification source of truth; report artifacts summarize the run and do not replace verification evidence.
- Do not migrate existing application business logic without a separate integration spec.
- `npm run verify` may fail with structured JSON when environment or sandbox prerequisites are missing.

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

- `invalid_spec`: stop immediately, report schema errors, and ask for a corrected YAML or JSON spec.
- `environment_blocked`: report the missing runtime, command, or permission and do not claim generation or verification success.
- `sandbox_init_failed`: preserve the init output, report which fixed dependency or lock reference failed, and do not run generation.
- `generation_conflict`: stop before overwriting generated targets, report the conflicting paths, and ask whether to clean or choose a new module name.
- `backend_verify_failed`: report backend compile or CRUD smoke failures from the verifier output and keep the report status failed.
- `frontend_verify_failed`: report plus-ui build, route, or form-field failures from the verifier output and keep the report status failed.
- `report_failed`: preserve verification output, report that the summary artifact was not produced, and do not substitute a hand-written success summary for verifier evidence.
