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
- Confirm the latest golden path produced `reports/ruoyi-crud-agent-report.md` and `reports/ruoyi-crud-agent-report.json`.
- Confirm `README.md` states Phase 1 does not migrate production application logic.
- Confirm `skills/ruoyi-crud-agent/SKILL.md` is present and matches the manifest skill path.
- Confirm `docs/spec-format.md` documents the current schema and sample spec pointer.

Publish only after command output and generated report artifacts agree on the release state.
