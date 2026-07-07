import "../../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildIntegrationServer } from "../../test/integration.js";

void test("unauthenticated invite lookup routes share a per-IP rate limit", async () => {
  const app = await buildIntegrationServer();
  const remoteAddress = "198.51.100.80";

  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: attempt % 2 === 0 ? "/invites/lookup?token=missing" : "/board-invitations/lookup?token=missing",
      remoteAddress,
    });
    assert.equal(response.statusCode, 404);
  }

  const limited = await app.inject({
    method: "GET",
    url: "/invites/lookup?token=missing",
    remoteAddress,
  });

  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json<{ code: string }>().code, "RATE_LIMITED");
  assert.ok(Number(limited.headers["retry-after"]) > 0);
});
