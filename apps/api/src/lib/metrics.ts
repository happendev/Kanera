import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import client from "prom-client";
import { env } from "../env.js";

// One Prometheus registry per process. api/worker/public-api each run as their own Node process, so a
// single registry here is correct; Prometheus tells them apart via the per-job label on each scrape,
// not via a service label baked into the metrics.
export const metricsRegistry = new client.Registry();

// Node runtime metrics: event loop lag, heap/RSS, GC pauses, active handles. Registered once at module
// load (this module is a singleton), which keeps it idempotent even when tests build several servers
// in the same process.
client.collectDefaultMetrics({ register: metricsRegistry });

// HTTP latency histogram. The `route` label is the matched Fastify route pattern (e.g.
// /boards/:boardId), never the raw URL, so per-id paths collapse into one bounded series instead of
// exploding cardinality. This is the same duration the slow-request hook already logs, recorded for
// every response so the percentiles cover all traffic, not only the slow tail.
export const httpRequestDuration = new client.Histogram({
  name: "kanera_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

// Database query latency, fed from the existing instrumentQuery wrapper in db.ts. Intentionally has no
// SQL-text label: statement text is unbounded cardinality and would blow up the series count. To
// attribute slow time to specific statements, use pg_stat_statements on the Postgres side.
export const dbQueryDuration = new client.Histogram({
  name: "kanera_db_query_duration_seconds",
  help: "Database query duration in seconds",
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [metricsRegistry],
});

// Bounded OAuth funnel telemetry. Client names, ids, scopes, tokens, and Kanera content are
// intentionally excluded; deployment operators only need flow/outcome counts to spot breakage.
export const oauthOperationsTotal = new client.Counter({
  name: "kanera_oauth_operations_total",
  help: "Successful OAuth operations by flow",
  labelNames: ["operation", "client_kind"],
  registers: [metricsRegistry],
});

// pg pool saturation. A sustained nonzero `waiting` means requests are queued waiting for a connection,
// i.e. PG_POOL_MAX (or the database) is the bottleneck. Read live at scrape time via a collect
// callback. db.ts registers the provider so this module never imports db.ts (avoids a circular import).
let poolStatsProvider: (() => { total: number; idle: number; waiting: number }) | null = null;
export function registerPoolStatsProvider(provider: () => { total: number; idle: number; waiting: number }): void {
  poolStatsProvider = provider;
}

const pgPoolConnections = new client.Gauge({
  name: "kanera_pg_pool_connections",
  help: "Postgres connection pool size by state",
  labelNames: ["state"],
  registers: [metricsRegistry],
  // Pulled at scrape time so the gauge always reflects the pool's current state.
  collect() {
    if (!poolStatsProvider) return;
    const stats = poolStatsProvider();
    pgPoolConnections.set({ state: "total" }, stats.total);
    pgPoolConnections.set({ state: "idle" }, stats.idle);
    pgPoolConnections.set({ state: "waiting" }, stats.waiting);
  },
});

// Constant-time compare so the token guard does not leak length/prefix via response timing.
function authorizationMatches(provided: string | undefined): boolean {
  const expected = env.METRICS_TOKEN;
  // Fail closed when the secret is missing. Some services share their application listener with
  // public traffic, so network topology must never silently become the authentication mechanism.
  if (!expected) return false;
  if (!provided) return false;
  const expectedBuf = Buffer.from(`Bearer ${expected}`);
  const providedBuf = Buffer.from(provided);
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

// Shared across buildServer / buildWorkerServer / buildPublicApiServer so all three processes expose
// the same /metrics surface. No-op when METRICS_ENABLED is false.
export function registerMetrics(app: FastifyInstance): void {
  if (!env.METRICS_ENABLED) return;

  // Record every response (the slow-request hook short-circuits below its threshold, so it cannot be
  // reused for full-distribution percentiles). reply.elapsedTime is ms since the request started.
  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions?.url ?? "unmatched";
    // Exclude infrastructure endpoints (fixed-interval scrapes/polls) and media routes.
    // Media latency is dominated by file size and client network speed, not server processing,
    // so including it skews the p95 histogram and masks real backend slow spots.
    if (route === "/health" || route === "/metrics") return;
    if (route.startsWith("/media/") || route.startsWith("/api/media/")) return;
    httpRequestDuration.observe(
      { method: req.method, route, status_code: reply.statusCode },
      reply.elapsedTime / 1000,
    );
  });

  // public-api is internet-facing (api.kanera.example.com), so /metrics must be token-gated there even
  // though it is internal-only on the app api. A missing/incorrect token returns 404 rather than 401 so
  // the endpoint is not advertised to anonymous callers.
  app.get("/metrics", { config: { logLevel: "silent" } }, async (req, reply) => {
    if (!authorizationMatches(req.headers.authorization)) {
      reply.code(404).send({ code: "NOT_FOUND", message: "Not Found" });
      return;
    }
    reply.header("Content-Type", metricsRegistry.contentType);
    return metricsRegistry.metrics();
  });
}
