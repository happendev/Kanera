-- Least-privilege login role for postgres-exporter, provisioned by the `postgres-exporter-init`
-- one-shot service in docker-compose.yml.
--
-- Two reasons this role exists rather than reusing the application role:
--
-- 1. The exporter only ever reads statistics, so `pg_monitor` (which carries pg_read_all_stats) is
--    all it needs. Scraping metrics as the database owner hands a monitoring sidecar full write
--    access to application data for no benefit.
-- 2. It makes the exporter's own catalog queries attributable. postgres-exporter runs a batch of
--    pg_stat_* queries on every scrape, and those land in pg_stat_statements alongside real
--    application traffic. `--collector.stat_statements.exclude_users=kanera_exporter` filters them
--    out by role, which is the only reliable way: filtering on query text cannot work, because the
--    exported text is truncated to query_length before the identifying table name appears.
--
-- Runs on every deploy of the monitoring profile, so every statement must be idempotent.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'kanera_exporter') THEN
    CREATE ROLE kanera_exporter WITH LOGIN;
  END IF;
END
$$;

-- Set the password on every run so a rotated POSTGRES_EXPORTER_PASSWORD reaches an existing role
-- instead of being silently ignored.
--
-- The password MUST NOT appear literally in this statement. pg_stat_statements stores utility
-- statements (ALTER ROLE among them) verbatim without normalising literals, and this exporter
-- publishes that text as a Prometheus label — so a plain `ALTER ROLE ... PASSWORD 'secret'` would
-- leak the credential into Grafana and into Prometheus' retained history. Instead the value arrives
-- as a connection-time GUC via PGOPTIONS (never a statement, so never recorded) and is applied
-- through dynamic SQL. Because the server runs pg_stat_statements.track=top, the nested EXECUTE is
-- not tracked either; only this DO block's own text is, and it holds just the current_setting call.
DO $$
BEGIN
  EXECUTE format(
    'ALTER ROLE kanera_exporter WITH LOGIN PASSWORD %L',
    current_setting('kanera.exporter_password')
  );
END
$$;

GRANT pg_monitor TO kanera_exporter;
GRANT CONNECT ON DATABASE kanera TO kanera_exporter;
