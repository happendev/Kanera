import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { configureOpsAlertsForTests } from "./lib/ops-alerts.js";
import { buildTestServer } from "./test/server.js";

afterEach(() => {
  configureOpsAlertsForTests(null);
});

function parseJsonBody(body: RequestInit["body"] | null | undefined): unknown {
  return typeof body === "string" ? JSON.parse(body) : null;
}

void test("GET /health returns ok", async () => {
  const app = await buildTestServer();

  const response = await app.inject({ method: "GET", url: "/health" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true });
  const requestId = response.headers["x-request-id"];
  if (typeof requestId !== "string") {
    assert.fail("expected x-request-id response header");
  }
  assert.match(requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

void test("GET /health preserves inbound request ids", async () => {
  const app = await buildTestServer();

  const response = await app.inject({
    method: "GET",
    url: "/health",
    headers: { "x-request-id": "trace-health-check" },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["x-request-id"], "trace-health-check");
});

void test("GET /health includes browser security headers", async () => {
  const app = await buildTestServer();

  const response = await app.inject({ method: "GET", url: "/health" });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["strict-transport-security"], "max-age=31536000; includeSubDomains");
  assert.equal(response.headers["x-frame-options"], "SAMEORIGIN");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["referrer-policy"], "strict-origin-when-cross-origin");
  assert.match(response.headers["permissions-policy"]?.toString() ?? "", /camera=\(\)/);
  assert.equal(response.headers["content-security-policy"], "default-src 'none';base-uri 'none';frame-ancestors 'self'");
});

void test("GET /workspaces requires authentication", async () => {
  const app = await buildTestServer();

  const response = await app.inject({ method: "GET", url: "/workspaces" });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), { code: "UNAUTHORIZED", message: "unauthorized" });
});

// Slow requests are logged (and shipped to Loki) but intentionally do NOT fire an ops-alert webhook;
// aggregate latency alerting is owned by Grafana's p95 rule. This guards that consolidation.
void test("slow app API requests do not emit an ops alert", async () => {
  const calls: unknown[] = [];
  configureOpsAlertsForTests({
    env: {
      NODE_ENV: "test",
      OPS_ALERTS_ENABLED: true,
      OPS_ALERT_THROTTLE_MS: 0,
      ALERT_WEBHOOK_URL: "https://hooks.slack.test/services/secret",
    },
    fetch: async (_input, init) => {
      calls.push(parseJsonBody(init?.body));
      return new Response("ok", { status: 200 });
    },
  });
  const app = await buildTestServer({ slowRequestLogMs: -1 });

  const response = await app.inject({ method: "GET", url: "/health" });

  assert.equal(response.statusCode, 200);
  assert.equal(calls.length, 0);
});
