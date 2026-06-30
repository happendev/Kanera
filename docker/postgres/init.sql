-- Extensions Kanera relies on.
CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- cryptographic helpers
CREATE EXTENSION IF NOT EXISTS "citext";   -- case-insensitive text for emails/slugs

-- Query-level performance telemetry: ranks statements by total/mean execution time and call count.
-- Requires shared_preload_libraries=pg_stat_statements (set on the postgres service `command` in
-- docker-compose.yml). On an already-initialised cluster this init script does not re-run, so run
-- `CREATE EXTENSION IF NOT EXISTS pg_stat_statements;` once manually after enabling the preload.
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements"; -- per-statement timing for slow-query analysis

-- PostgreSQL 18 provides uuidv7() natively for time-ordered UUID defaults.
