import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { env } from "../env.js";
import { registerMetrics, timestampAgeSeconds } from "./metrics.js";

void test("timestampAgeSeconds accepts aggregate timestamps returned as Dates or strings", () => {
  const now = Date.parse("2026-08-25T11:15:34.000Z");

  assert.equal(timestampAgeSeconds(new Date("2026-08-25T11:15:04.000Z"), now), 30);
  assert.equal(timestampAgeSeconds("2026-08-25T11:14:34.000Z", now), 60);
  assert.equal(timestampAgeSeconds(null, now), 0);
  assert.equal(timestampAgeSeconds("not-a-timestamp", now), 0);
});

void test("GET /metrics fails closed and accepts only the configured bearer token", async () => {
  const app = Fastify({ logger: false });
  const originalToken = env.METRICS_TOKEN;

  try {
    registerMetrics(app);

    env.METRICS_TOKEN = undefined;
    const missingConfiguration = await app.inject({ method: "GET", url: "/metrics" });
    assert.equal(missingConfiguration.statusCode, 404);

    env.METRICS_TOKEN = "metrics-test-token-32-characters";
    const incorrectToken = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: "Bearer incorrect-metrics-token" },
    });
    assert.equal(incorrectToken.statusCode, 404);

    const validToken = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: "Bearer metrics-test-token-32-characters" },
    });
    assert.equal(validToken.statusCode, 200);
    assert.match(validToken.headers["content-type"]?.toString() ?? "", /text\/plain/);
    assert.match(validToken.body, /kanera_http_request_duration_seconds/);
  } finally {
    env.METRICS_TOKEN = originalToken;
    await app.close();
  }
});
