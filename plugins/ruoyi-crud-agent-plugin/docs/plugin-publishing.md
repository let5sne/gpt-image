# Plugin Publishing

The Codex plugin manifest lives at `.codex-plugin/plugin.json`. It points to the bundled skill directory at `skills/ruoyi-crud-agent`.

## Pre-Publish Commands

```bash
cd plugins/ruoyi-crud-agent-plugin
npm install
npm test
npm run validate
npm run init:sandbox
npm run generate
npm run verify
npm run report
```

## Release Checklist

- Confirm `.codex-plugin/plugin.json` version matches `package.json`.
- Confirm sandbox dependency references are immutable in `fixtures/versions.lock`.
- Confirm the latest golden path has a passing `npm run verify` exit status and verifier output.
- Confirm the latest golden path produced summary artifacts at `reports/ruoyi-crud-agent-report.md` and `reports/ruoyi-crud-agent-report.json`.
- Confirm `README.md` documents that the MVP does not migrate existing production business logic or current app APIs.
- Confirm `skills/ruoyi-crud-agent/SKILL.md` is present and matches the manifest skill path.
- Confirm `docs/spec-format.md` documents the current schema and sample spec pointer.

Publish only after `npm run verify` passes. Treat report artifacts as summaries after verification, not as substitutes for verifier evidence.
