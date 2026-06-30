import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { env } from "../env.js";
import { registerMetrics } from "./metrics.js";

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
