import * as schema from "@kanera/shared/schema";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "./env.js";
import { dbQueryDuration, registerPoolStatsProvider } from "./lib/metrics.js";

function assertSafeTestDatabase(databaseUrl: string): void {
  if (env.NODE_ENV !== "test") return;

  const parsed = new URL(databaseUrl);
  const databaseName = parsed.pathname.replace(/^\//, "");
  if (parsed.username !== "kanera_test" || databaseName !== "kanera_test") {
    throw new Error(`Refusing to connect test process to non-test database: ${parsed.username}@${parsed.host}/${databaseName}`);
  }
}

assertSafeTestDatabase(env.DATABASE_URL);

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: env.PG_POOL_MAX,
  idleTimeoutMillis: env.PG_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: env.PG_CONNECTION_TIMEOUT_MS,
  statement_timeout: env.PG_STATEMENT_TIMEOUT_MS,
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: true } : false,
});

// Expose live pool saturation to the metrics registry. node-postgres updates these counters
// synchronously, so reading them at scrape time reflects the pool's current state.
registerPoolStatsProvider(() => ({
  total: pool.totalCount,
  idle: pool.idleCount,
  waiting: pool.waitingCount,
}));

type PgQuery = (...args: unknown[]) => unknown;

function isUnknownFunction(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === "function";
}

function errorMessage(error: unknown): string {
  if (Error.isError(error)) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown error";
  }
}

function slowQueryLogPayload(args: unknown[], durationMs: number, error?: unknown) {
  const firstArg = args[0];
  const sqlText = typeof firstArg === "string"
    ? firstArg
    : firstArg && typeof firstArg === "object" && "text" in firstArg && typeof firstArg.text === "string"
      ? firstArg.text
      : undefined;

  return {
    level: "warn",
    msg: error ? "slow database query failed" : "slow database query",
    durationMs: Math.round(durationMs),
    ...(sqlText ? { sql: sqlText.replace(/\s+/g, " ").trim().slice(0, 500) } : {}),
    ...(error ? { error: errorMessage(error) } : {}),
  };
}

function instrumentQuery(target: { query: PgQuery }): void {
  const rawQuery = target.query.bind(target) as PgQuery;
  // Skip the timing wrapper entirely only when nothing consumes the duration. The callback form is
  // always passed through untouched because its result is not a promise we can time via .then.
  const timingDisabled = !env.METRICS_ENABLED && env.SLOW_QUERY_LOG_MS === 0;
  target.query = (...args: unknown[]) => {
    if (timingDisabled || isUnknownFunction(args.at(-1))) return rawQuery(...args);
    const startedAt = performance.now();
    const result = rawQuery(...args) as Promise<unknown>;
    return result.then(
      (value) => {
        const durationMs = performance.now() - startedAt;
        if (env.METRICS_ENABLED) dbQueryDuration.observe(durationMs / 1000);
        if (env.SLOW_QUERY_LOG_MS > 0 && durationMs >= env.SLOW_QUERY_LOG_MS) {
          console.warn(JSON.stringify(slowQueryLogPayload(args, durationMs)));
        }
        return value;
      },
      (error) => {
        const durationMs = performance.now() - startedAt;
        // Failed queries still consumed DB time; record them so latency spikes from errors are visible.
        if (env.METRICS_ENABLED) dbQueryDuration.observe(durationMs / 1000);
        if (env.SLOW_QUERY_LOG_MS > 0 && durationMs >= env.SLOW_QUERY_LOG_MS) {
          console.warn(JSON.stringify(slowQueryLogPayload(args, durationMs, error)));
        }
        throw error;
      },
    );
  };
}

instrumentQuery(pool as unknown as { query: PgQuery });

const instrumentedClients = new WeakSet<object>();
const connectTarget = pool as unknown as { connect: (...args: unknown[]) => unknown };
const rawConnect = connectTarget.connect.bind(pool);
connectTarget.connect = (...args: unknown[]) => {
  const callback = args[0];
  if (isUnknownFunction(callback)) {
    const connectCallback = callback;
    return rawConnect((error: unknown, client: unknown, done: unknown) => {
      if (client && typeof client === "object" && !instrumentedClients.has(client)) {
        instrumentQuery(client as { query: PgQuery });
        instrumentedClients.add(client);
      }
      connectCallback(error, client, done);
    });
  }

  return (rawConnect() as Promise<unknown>).then((client) => {
    if (client && typeof client === "object" && !instrumentedClients.has(client)) {
      instrumentQuery(client as { query: PgQuery });
      instrumentedClients.add(client);
    }
    return client;
  });
};

export const db = drizzle(pool, { schema });
export type Db = typeof db;
