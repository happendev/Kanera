import "./test/setup.integration.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { workspaceApiKeys } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import { db } from "./db.js";
import { hashOpaqueToken } from "./lib/tokens.js";
import { buildPublicApiServer } from "./public-api-server.js";
import { buildIntegrationServer, testUploadsDir } from "./test/integration.js";

async function createWorkspaceApiKey() {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Rate Limit Co",
      email: `rate-limit-${randomUUID()}@example.com`,
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken } = signup.json<{ accessToken: string }>();

  const workspaceCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Rate Limits" },
  });
  assert.equal(workspaceCreated.statusCode, 201);
  const workspace = workspaceCreated.json<{ id: string }>();

  const key = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/api-keys`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Sync", scope: "write" },
  });
  assert.equal(key.statusCode, 201);

  return key.json<{ secret: string }>().secret;
}

async function loadApiKey(secret: string) {
  const [row] = await db
    .select({ id: workspaceApiKeys.id, lastUsedAt: workspaceApiKeys.lastUsedAt, updatedAt: workspaceApiKeys.updatedAt })
    .from(workspaceApiKeys)
    .where(eq(workspaceApiKeys.keyHash, hashOpaqueToken(secret)))
    .limit(1);
  assert.ok(row);
  return row;
}

void test("public API keys are rate limited by API key id", async () => {
  const secret = await createWorkspaceApiKey();
  const publicApi = await buildPublicApiServer({
    enableWebhookDeliveryScheduler: false,
    logger: false,
    rateLimit: { apiKeyLimitPerMinute: 1, ipLimitPerMinute: 100, uploadLimitPerMinute: 100, windowMs: 60_000 },
    uploadsDir: testUploadsDir("test-public-uploads"),
  });

  try {
    const first = await publicApi.inject({
      method: "GET",
      url: "/api/v1/workspaces",
      headers: { authorization: `Bearer ${secret}` },
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.headers["ratelimit-limit"], "1");
    assert.equal(first.headers["ratelimit-remaining"], "0");

    const limited = await publicApi.inject({
      method: "GET",
      url: "/api/v1/workspaces",
      headers: { authorization: `Bearer ${secret}` },
    });
    assert.equal(limited.statusCode, 429);
    assert.deepEqual(limited.json(), { code: "RATE_LIMITED", message: "rate limit exceeded" });
    assert.equal(limited.headers["ratelimit-limit"], "1");
    assert.ok(limited.headers["ratelimit-reset"]);
    assert.ok(limited.headers["retry-after"]);
  } finally {
    await publicApi.close();
  }
});

void test("failed public API key auth is rate limited by IP", async () => {
  const publicApi = await buildPublicApiServer({
    enableWebhookDeliveryScheduler: false,
    logger: false,
    rateLimit: {
      apiKeyLimitPerMinute: 100,
      failedApiKeyLimitPerMinute: 1,
      ipLimitPerMinute: 100,
      uploadLimitPerMinute: 100,
      windowMs: 60_000,
    },
    uploadsDir: testUploadsDir("test-public-uploads"),
  });

  try {
    const first = await publicApi.inject({
      method: "GET",
      url: "/api/v1/workspaces",
      headers: { authorization: "Bearer kanera_guess" },
    });
    assert.equal(first.statusCode, 401);
    assert.equal(first.headers["ratelimit-limit"], "1");
    assert.equal(first.headers["ratelimit-remaining"], "0");
    assert.ok(first.headers["ratelimit-reset"]);
    assert.ok(first.headers["retry-after"]);

    const limited = await publicApi.inject({
      method: "GET",
      url: "/api/v1/workspaces",
      headers: { authorization: "Bearer kanera_guess" },
    });
    assert.equal(limited.statusCode, 429);
    assert.deepEqual(limited.json(), { code: "RATE_LIMITED", message: "rate limit exceeded" });
    assert.equal(limited.headers["ratelimit-limit"], "1");
    assert.equal(limited.headers["ratelimit-remaining"], "0");
    assert.ok(limited.headers["ratelimit-reset"]);
    assert.ok(limited.headers["retry-after"]);
  } finally {
    await publicApi.close();
  }
});

void test("public API key lastUsedAt writes are throttled", async () => {
  const secret = await createWorkspaceApiKey();
  const publicApi = await buildPublicApiServer({
    enableWebhookDeliveryScheduler: false,
    logger: false,
    rateLimit: { enabled: false },
    uploadsDir: testUploadsDir("test-public-uploads"),
  });

  try {
    const first = await publicApi.inject({
      method: "GET",
      url: "/api/v1/workspaces",
      headers: { authorization: `Bearer ${secret}` },
    });
    assert.equal(first.statusCode, 200);
    const afterFirst = await loadApiKey(secret);
    assert.ok(afterFirst.lastUsedAt);

    const second = await publicApi.inject({
      method: "GET",
      url: "/api/v1/workspaces",
      headers: { authorization: `Bearer ${secret}` },
    });
    assert.equal(second.statusCode, 200);
    const afterSecond = await loadApiKey(secret);

    assert.equal(afterSecond.lastUsedAt?.toISOString(), afterFirst.lastUsedAt.toISOString());
    assert.equal(afterSecond.updatedAt.toISOString(), afterFirst.updatedAt.toISOString());
  } finally {
    await publicApi.close();
  }
});

void test("public API attachment uploads use the lower upload rate limit", async () => {
  const secret = await createWorkspaceApiKey();
  const publicApi = await buildPublicApiServer({
    enableWebhookDeliveryScheduler: false,
    logger: false,
    rateLimit: { apiKeyLimitPerMinute: 100, ipLimitPerMinute: 100, uploadLimitPerMinute: 1, windowMs: 60_000 },
    uploadsDir: testUploadsDir("test-public-uploads"),
  });

  try {
    const first = await publicApi.inject({
      method: "POST",
      url: "/api/v1/cards/00000000-0000-0000-0000-000000000001/attachments",
      headers: { authorization: `Bearer ${secret}` },
    });
    assert.notEqual(first.statusCode, 429);

    const limited = await publicApi.inject({
      method: "POST",
      url: "/api/v1/cards/00000000-0000-0000-0000-000000000001/attachments",
      headers: { authorization: `Bearer ${secret}` },
    });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.headers["ratelimit-limit"], "1");
  } finally {
    await publicApi.close();
  }
});
