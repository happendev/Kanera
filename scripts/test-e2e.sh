#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
if [[ "${1:-}" == "--" ]]; then shift; fi

exec 9>"${TMPDIR:-/tmp}/kanera-e2e.lock"
if ! flock -n 9; then
  echo "Another Kanera E2E run is using the isolated test database." >&2
  exit 1
fi

# E2E-only ports (e2e/ports.json) so a local dev stack on 3000-3003/4200 can keep running.
for port in $(node -p "Object.values(require('./e2e/ports.json')).join(' ')"); do
  if (echo >"/dev/tcp/127.0.0.1/$port") >/dev/null 2>&1; then
    echo "Port $port is already in use; stop that service before running the isolated E2E suite." >&2
    exit 1
  fi
done

run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
export KANERA_E2E_ARTIFACT_DIR="$PWD/e2e/artifacts/$run_id"
mkdir -p "$KANERA_E2E_ARTIFACT_DIR"

# Each run keeps traces and screenshots for every test (~200 MB). Keep the newest runs locally;
# CI uploads its single run as a workflow artifact instead.
keep_runs="${KANERA_E2E_KEEP_RUNS:-10}"
find e2e/artifacts -mindepth 1 -maxdepth 1 -type d -name '20*' | sort -r | tail -n +"$((keep_runs + 1))" | xargs -r rm -rf

# Not NODE_ENV=test: in test mode apps/api/src/redis.ts swaps Valkey for an in-process ioredis-mock,
# so each service would get its own private "Valkey" and cross-process realtime (worker outbox ->
# Socket.IO Redis adapter -> API sockets) could never deliver. E2E must run the real topology.
# KANERA_ENVIRONMENT still marks the deployment as test in the UI.
export NODE_ENV=development
export KANERA_ENVIRONMENT=test
export KANERA_DEPLOYMENT_MODE=self_hosted
export DATABASE_URL=postgres://kanera_test:kanera_test@localhost:55434/kanera_test_e2e
export REDIS_URL=redis://localhost:56380/0
export JWT_SECRET=kanera_e2e_jwt_secret_for_isolated_run
export MFA_ENCRYPTION_KEY=kanera_e2e_mfa_encryption_key_for_isolated_run
export MEDIA_SIGNING_SECRET=kanera_e2e_media_signing_secret_for_isolated_run
export SECRETS_ENCRYPTION_KEY=kanera_e2e_distinct_secrets_key_for_isolated_run
export ADMIN_JWT_SECRET=kanera_e2e_distinct_admin_jwt_secret
export MCP_INTERNAL_SECRET=kanera_e2e_distinct_mcp_internal_secret
export UPLOADS_DIR="$KANERA_E2E_ARTIFACT_DIR/uploads"
# Tests sign in through the API (e2e/support/fixtures.ts), all from one IP. The production limit of
# 10 logins/minute would make results depend on machine speed. The limiter stays enabled; its
# behaviour is covered by apps/api/src/auth/routes.itest.ts.
export AUTH_RATE_LIMIT_MAX=1000

# HEAD alone does not reproduce a run from a dirty tree, so capture the uncommitted state too:
# tracked changes as a patch and untracked files as a tarball, both relative to HEAD.
git diff HEAD --binary >"$KANERA_E2E_ARTIFACT_DIR/worktree.patch"
git ls-files --others --exclude-standard -z | tar --null -czf "$KANERA_E2E_ARTIFACT_DIR/untracked.tar.gz" -T -
if [[ -n "$(git status --porcelain)" ]]; then tree_state="dirty (apply worktree.patch and extract untracked.tar.gz on top of the revision)"; else tree_state="clean"; fi

cat >"$KANERA_E2E_ARTIFACT_DIR/REPRODUCE.txt" <<EOF
Command: pnpm test:e2e${*:+ -- $*}
Git revision: $(git rev-parse HEAD)
Working tree: $tree_state
Run UTC: $(date -u +%Y-%m-%dT%H:%M:%SZ)
Fixture: fresh isolated Docker Postgres and Valkey; pnpm --filter @kanera/api db:seed
Accounts: seeded users from dev-db-seed-content/README.md (password Abc12345); signup tests create their own
Test data: names carry a per-test suffix (uniqueName in e2e/support/fixtures.ts); every run starts from a fresh migrated and seeded database
Browser: Playwright Chromium, timezone UTC, locale en-US; install with pnpm exec playwright install chromium
EOF

cleanup() {
  status=$?
  trap - EXIT
  printf 'Exit status: %s\n' "$status" >>"$KANERA_E2E_ARTIFACT_DIR/REPRODUCE.txt"
  docker compose -p kanera-e2e -f docker-compose.e2e.yml down -v >"$KANERA_E2E_ARTIFACT_DIR/docker-down.log" 2>&1 || true
  echo "E2E artifacts: $KANERA_E2E_ARTIFACT_DIR"
  exit "$status"
}
trap cleanup EXIT

docker compose -p kanera-e2e -f docker-compose.e2e.yml down -v >"$KANERA_E2E_ARTIFACT_DIR/docker-before.log" 2>&1
docker compose -p kanera-e2e -f docker-compose.e2e.yml up -d --wait >"$KANERA_E2E_ARTIFACT_DIR/docker-up.log" 2>&1
pnpm --filter @kanera/api db:migrate >"$KANERA_E2E_ARTIFACT_DIR/migrate.log" 2>&1
pnpm --filter @kanera/api db:seed >"$KANERA_E2E_ARTIFACT_DIR/seed.log" 2>&1
# The web server runs `ng serve` directly, which skips apps/web's `prestart` hook. Run it here: it
# writes the gitignored build-info.generated.ts and generated assets that a clean checkout (CI)
# lacks. As a separate step, a failure here is reported instead of surfacing as a web-server timeout.
pnpm --filter @kanera/web run prestart >"$KANERA_E2E_ARTIFACT_DIR/web-prepare.log" 2>&1
pnpm exec playwright test --config e2e/playwright.config.ts "$@"
