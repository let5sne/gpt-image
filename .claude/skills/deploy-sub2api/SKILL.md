---
name: deploy-sub2api
description: >-
  Deploy / release the gpt-image app to the sub2api production host
  (sub2api-tokyo-01, /data/gpt-image) via the release-dir + symlink +
  docker-compose flow. Use when asked to 发布 / 上线 / deploy / release / ship
  this project to the sub2api host, or to roll back a release. Covers
  packaging with `git archive`, the Dockerfile-not-in-git gotcha, pre-deploy
  backups of credits.json/.env, symlink switch, rebuild, health verification,
  and automatic rollback on failure.
---

# Deploy gpt-image to the sub2api host

Repeatable, rollback-safe production deploy for this project. Production is a
single host reached with `ssh sub2api` (= `sub2api-tokyo-01`, Ubuntu, root).
The app runs as a Docker container behind a reverse proxy on `127.0.0.1:3001`.

This is HIGH-RISK: production, root, real credits data. Run the two phases in
order, confirm Phase A output before starting Phase B, and never skip the
pre-deploy backup. Phase B has auto-rollback built in.

## Environment facts (verified)

- Deploy root: `/data/gpt-image/`
- Layout: `current -> releases/<TIMESTAMP>` (symlink), plus `releases/`,
  `backups/`, `storage/`, `docker-compose.yml`, `.env`.
- `storage/` is bind-mounted to the container `/app/storage` and holds the real
  `credits.json`. Rebuilds and rollbacks do NOT touch it — data survives.
- Code ships as a tarball (`git archive HEAD`); the host dir is NOT a git repo.
  compose uses `build.context: ./current`, `env_file: ./.env`, healthcheck on
  `/api/health`.
- The host `.env` is already correct (CREDIT_COST_* all 20, CREDITS_ENABLED,
  IMAGE_PROVIDER). A normal code deploy must NOT change it.

## ⚠ Critical gotcha: Dockerfile is not in git

The repo has no `Dockerfile` — it exists only on the host inside the current
release. `git archive` omits it, so a fresh release would fail to build. Phase
A copies the Dockerfile from the OLD release into the NEW one. (If you ever add
Dockerfile to the repo, that copy step simply becomes redundant.)

## Preflight

Local `main` pushed and clean, CI green / `npm test` passing. You deploy
committed `HEAD`, so anything uncommitted will NOT ship.

## Phase A — package, transfer, stage, back up (fully reversible)

Does NOT touch the running container. Safe to abort after this phase. Run from
the repo root locally:

```bash
cd /path/to/gpt-image            # repo root
set -e
TS=$(date +%Y%m%d%H%M%S)
echo "release=$TS HEAD=$(git rev-parse --short HEAD) branch=$(git rev-parse --abbrev-ref HEAD)"

# 1) package committed HEAD (excludes .git/.env/node_modules by construction)
git archive --format=tar HEAD -o /tmp/gpt-image-release-$TS.tar

# 2) transfer
scp -q /tmp/gpt-image-release-$TS.tar sub2api:/tmp/

# 3) remote: unpack into new release, inject Dockerfile from OLD release, back up
ssh sub2api "TS='$TS' bash -s" <<'EOF'
set -e
cd /data/gpt-image
OLD=$(readlink current)
echo "$OLD" > /tmp/gpt-image-rollback-target.txt   # rollback anchor
mkdir -p "releases/$TS"
tar -xf "/tmp/gpt-image-release-$TS.tar" -C "releases/$TS"
cp "$OLD/Dockerfile" "releases/$TS/Dockerfile"      # ⚠ Dockerfile not in git
cp storage/credits.json "backups/credits.json.$TS.pre-deploy"
cp .env "backups/.env.$TS.pre-deploy"
# sanity: new code present, backups taken
echo "quality-dropdown(expect 0): $(grep -c 'id=\"quality\"' releases/$TS/public/index.html)"
echo "force-auto(expect >=1): $(grep -c \"const quality = 'auto'\" releases/$TS/server.js)"
echo "dockerfile: $(head -1 releases/$TS/Dockerfile)"
ls -la "backups/credits.json.$TS.pre-deploy"
EOF
```

Confirm: `quality-dropdown=0`, `force-auto>=1`, Dockerfile present, backup
sized. Only then proceed to Phase B. Remember `$TS` for the next phase.

## Phase B — switch, rebuild, verify (auto-rollback on failure)

Touches the running container. Brief restart blip on `127.0.0.1:3001` (proxy may
502 for a few seconds). `storage/credits.json` is bind-mounted — untouched by
rebuild/rollback. Set `TS` to the Phase A timestamp first. Give the SSH command
a generous timeout (`npm ci` build can take 1–3 min):

```bash
TS=20260531233058   # <-- the Phase A timestamp
ssh sub2api "TS='$TS' bash -s" <<'EOF'
set +e
cd /data/gpt-image
NEW="/data/gpt-image/releases/$TS"
OLD=$(cat /tmp/gpt-image-rollback-target.txt)
ln -sfn "$NEW" current                                  # 1) switch symlink
docker compose up -d --build > /tmp/deploy-build.log 2>&1; BUILD_RC=$?
tail -8 /tmp/deploy-build.log
ok=0
if [ "$BUILD_RC" = "0" ]; then
  for i in $(seq 1 24); do                              # 2) wait healthy
    [ "$(docker inspect gpt-image --format '{{.State.Health.Status}}')" = healthy ] && break; sleep 5
  done
  H=$(curl -s --max-time 8 http://127.0.0.1:3001/api/health)
  Q=$(curl -s --max-time 8 http://127.0.0.1:3001/ | grep -c 'id="quality"')
  echo "health: $(echo "$H" | head -c 80) | quality(expect 0): $Q"
  echo "$H" | grep -q '"status":"ok"' && [ "$Q" = 0 ] && ok=1
fi
if [ "$ok" = 1 ]; then
  echo "=== ✓ DEPLOY OK: current -> $(readlink current) ==="
else
  echo "=== ✗ FAILED → rollback to $OLD ==="           # 3) auto-rollback
  ln -sfn "$OLD" current
  docker compose up -d --build > /tmp/deploy-rollback.log 2>&1
  echo "rolled back: current -> $(readlink current)"
fi
EOF
```

## Manual rollback (if ever needed later)

```bash
ssh sub2api 'cd /data/gpt-image && ln -sfn "$(cat /tmp/gpt-image-rollback-target.txt)" current && docker compose up -d --build'
```
Real credits data is safe — it lives in the bind-mounted `storage/`, never in the
release dir.

## Post-deploy

- Public entry: container binds `127.0.0.1:3001` only; verify the live domain in
  a browser (quality dropdown gone, generation charges 20). The reverse proxy is
  NOT nginx by `server_name` — confirm the real entry separately.
- `releases/` is never auto-pruned. To trim disk, delete OLD release dirs only —
  never `current`, `backups/`, or `storage/`.
- Cleanup: `rm -f /tmp/gpt-image-release-*.tar` on both local and host.

## Known limitations / TODO

- **Dockerfile lives only on the host, not in git.** If someone wipes the host
  releases, there's no Dockerfile to copy. Consider committing it to the repo;
  then drop the "copy Dockerfile from OLD release" step in Phase A.


