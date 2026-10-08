#!/usr/bin/env bash
# Disposable local benchmark; refuses to overwrite an existing database. No dev records modified.
set -euo pipefail
cd "$(dirname "$0")/../.."
export PGHOST="${KANERA_PERF_DB_HOST:-localhost}"
export PGPORT="${KANERA_PERF_DB_PORT:-5433}"
export PGUSER="${KANERA_PERF_DB_USER:-kanera}"
export PGPASSWORD="${KANERA_PERF_DB_PASSWORD:-kanera}"
case "$PGHOST" in
  localhost|127.0.0.1) ;;
  *) echo "Refusing to create performance fixtures outside localhost" >&2; exit 1 ;;
esac
perf_database="kanera_test_perf_backend_$$"
createdb "$perf_database"
trap 'dropdb "$perf_database"' EXIT
export DATABASE_URL="postgres://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/${perf_database}"
pnpm --filter @kanera/api db:migrate
pnpm --dir apps/api exec tsx ../../benchmarks/performance/backend-proof.mjs seed
for mode in full paged; do
  for sample in 1 2 3; do
    pnpm --dir apps/api exec node --expose-gc --import tsx ../../benchmarks/performance/backend-proof.mjs "$mode"
  done
done
pnpm --dir apps/api exec tsx ../../benchmarks/performance/backend-proof.mjs parity
pnpm --dir apps/api exec tsx ../../benchmarks/performance/backend-proof.mjs links
pnpm --dir apps/api exec tsx ../../benchmarks/performance/backend-proof.mjs indexes
