#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

export DATABASE_URL="postgres://kanera_test:kanera_test@localhost:55433/kanera_test"
export REDIS_URL="redis://localhost:56379/0"
export MFA_ENCRYPTION_KEY="test-mfa-encryption-key-with-enough-length"

if [[ "${1:-}" == "--" ]]; then
  shift
fi

test_args=()
if [[ "$#" -eq 0 ]]; then
  test_args=("src/**/*.itest.ts")
else
  for arg in "$@"; do
    # Let callers pass paths from the repo root, e.g.
    # `pnpm test:api:integration -- apps/api/src/modules/foo/routes.itest.ts`.
    if [[ "$arg" == apps/api/* ]]; then
      test_args+=("${arg#apps/api/}")
    else
      test_args+=("$arg")
    fi
  done
fi

docker compose -p kanera-api-test -f docker-compose.test.yml up -d --wait
trap 'docker compose -p kanera-api-test -f docker-compose.test.yml down -v' EXIT

pnpm --dir apps/api exec node <<'NODE'
const pg = require("pg");

const connectionString = process.env.DATABASE_URL;
const deadline = Date.now() + 30_000;
let lastError;

(async () => {
  while (Date.now() < deadline) {
    const client = new pg.Client({ connectionString });
    try {
      await client.connect();
      await client.query("select 1");
      await client.end();
      process.exit(0);
    } catch (error) {
      lastError = error;
      try {
        await client.end();
      } catch {
        // The connection may not have opened yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  console.error("Timed out waiting for test database:", lastError?.message ?? lastError);
  process.exit(1);
})();
NODE

pnpm --filter @kanera/api db:migrate
KANERA_TEST_FILES="$(printf '%s\n' "${test_args[@]}")" pnpm --dir apps/api exec node scripts/run-integration-tests.mjs
