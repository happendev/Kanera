import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { configureOpsAlertsForTests } from "./lib/ops-alerts.js";
import { buildPublicApiServer, type PublicApiRateLimitOptions } from "./public-api-server.js";
import { trackTestServer } from "./test/server.js";

interface PublicOpenApiTestDocument {
  openapi: string;
  info: {
    description: string;
  };
  tags: Array<{
    name: string;
    description?: string;
  }>;
  components: {
    securitySchemes: {
      BearerAuth: {
        scheme: string;
      };
    };
    schemas: Record<string, {
      properties?: Record<string, unknown>;
    }>;
  };
  paths: {
    "/webhook-event-types": {
      get: {
        description?: string;
      };
    };
    "/workspaces": {
      get: {
        description?: string;
        security: Array<{ BearerAuth: string[] }>;
      };
    };
    "/boards/{boardId}/lists/{id}/cards": {
      post: object;
    };
    "/workspaces/{id}/external-links": {
      get: object;
      post: object;
    };
    "/cards/{id}/attachments": {
      post: {
        requestBody: {
          content: {
            "multipart/form-data": {
              schema: {
                properties: {
                  file: {
                    format: string;
                  };
                };
              };
            };
          };
        };
      };
    };
  };
}

async function buildPublicTestServer(rateLimit?: PublicApiRateLimitOptions) {
  const app = await buildPublicApiServer({
    enableWebhookDeliveryScheduler: false,
    logger: false,
    rateLimit,
    slowRequestLogMs: -1,
    uploadsDir: ".tmp/test-public-uploads",
  });
  return trackTestServer(app);
}

afterEach(() => {
  configureOpsAlertsForTests(null);
});

function parseJsonBody(body: RequestInit["body"] | null | undefined): unknown {
  return typeof body === "string" ? JSON.parse(body) : null;
}

void test("public API docs expose Scalar docs, Swagger UI, and OpenAPI JSON", async () => {
  const app = await buildPublicTestServer();

  const scalarRedirectResponse = await app.inject({ method: "GET", url: "/docs" });
  assert.equal(scalarRedirectResponse.statusCode, 301);
  assert.equal(scalarRedirectResponse.headers.location, "/docs/");

  const scalarResponse = await app.inject({ method: "GET", url: "/docs/" });
  assert.equal(scalarResponse.statusCode, 200);
  assert.match(scalarResponse.headers["content-type"]?.toString() ?? "", /text\/html/);
  assert.match(scalarResponse.body, /Kanera Public API/i);

  const swaggerResponse = await app.inject({ method: "GET", url: "/swagger" });
  assert.equal(swaggerResponse.statusCode, 200);
  assert.match(swaggerResponse.headers["content-type"]?.toString() ?? "", /text\/html/);
  assert.match(swaggerResponse.body, /Swagger UI/i);

  const specResponse = await app.inject({ method: "GET", url: "/openapi.json" });
  assert.equal(specResponse.statusCode, 200);
  assert.match(specResponse.headers["content-type"]?.toString() ?? "", /application\/json/);

  const spec = specResponse.json<PublicOpenApiTestDocument>();
  assert.equal(spec.openapi, "3.0.3");
  assert.match(spec.info.description, /Quickstart/i);
  assert.match(spec.info.description, /Workspace Settings -> API/i);
  assert.match(spec.info.description, /Authorization: Bearer/i);
  assert.match(spec.info.description, /X-Kanera-Event-Id/i);
  assert.match(spec.info.description, /X-Kanera-Timestamp/i);
  assert.match(spec.info.description, /X-Kanera-Signature/i);
  assert.match(spec.info.description, /webhook-event-types/i);
  assert.match(spec.info.description, /retried up to 8 attempts/i);
  assert.equal(spec.components.securitySchemes.BearerAuth.scheme, "bearer");
  assert.ok(spec.paths["/webhook-event-types"].get);
  assert.match(spec.paths["/webhook-event-types"].get.description ?? "", /eventTypes/i);
  assert.ok(spec.paths["/workspaces"].get);
  assert.match(spec.paths["/workspaces"].get.description ?? "", /Start here/i);
  assert.ok(spec.paths["/boards/{boardId}/lists/{id}/cards"].post);
  assert.ok(spec.paths["/workspaces/{id}/external-links"].get);
  assert.ok(spec.paths["/workspaces/{id}/external-links"].post);
  assert.ok(spec.paths["/cards/{id}/attachments"].post);
  assert.equal(spec.paths["/cards/{id}/attachments"].post.requestBody.content["multipart/form-data"].schema.properties.file.format, "binary");
  assert.equal(spec.paths["/workspaces"].get.security[0]?.BearerAuth.length, 0);
  assert.match(spec.tags.find((tag) => tag.name === "Webhooks")?.description ?? "", /HMAC-SHA256/);
  assert.ok(spec.components.schemas.Checklist?.properties?.parentItemId);
  assert.ok(spec.components.schemas.ChecklistItem?.properties?.description);
  assert.ok(spec.components.schemas.CreateChecklistBody?.properties?.parentItemId);
  assert.ok(spec.components.schemas.UpdateChecklistItemBody?.properties?.description);

  const webhookTypesResponse = await app.inject({ method: "GET", url: "/webhook-event-types" });
  assert.equal(webhookTypesResponse.statusCode, 200);
  const webhookTypes = webhookTypesResponse.json<{ eventTypes: string[] }>();
  assert.ok(webhookTypes.eventTypes.includes("card:created"));
  assert.ok(webhookTypes.eventTypes.includes("workspace:updated"));
});

void test("public API responses include browser security headers without breaking docs CSP", async () => {
  const app = await buildPublicTestServer();

  const jsonResponse = await app.inject({ method: "GET", url: "/openapi.json" });
  assert.equal(jsonResponse.statusCode, 200);
  assert.equal(jsonResponse.headers["strict-transport-security"], "max-age=31536000; includeSubDomains");
  assert.equal(jsonResponse.headers["x-frame-options"], "SAMEORIGIN");
  assert.equal(jsonResponse.headers["x-content-type-options"], "nosniff");
  assert.equal(jsonResponse.headers["referrer-policy"], "strict-origin-when-cross-origin");
  assert.match(jsonResponse.headers["permissions-policy"]?.toString() ?? "", /camera=\(\)/);
  assert.equal(jsonResponse.headers["content-security-policy"], "default-src 'none'; base-uri 'none'; frame-ancestors 'self'");

  const docsResponse = await app.inject({ method: "GET", url: "/docs/" });
  assert.equal(docsResponse.statusCode, 200);
  assert.match(docsResponse.headers["content-type"]?.toString() ?? "", /text\/html/);
  assert.equal(docsResponse.headers["content-security-policy"], undefined);
});

// Slow requests are logged (shipped to Loki) but do NOT fire an ops-alert webhook; latency alerting is
// owned by Grafana's p95 rule. This guards that consolidation on the public API too.
void test("slow public API requests do not emit an ops alert", async () => {
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
  const app = await buildPublicTestServer();

  const response = await app.inject({ method: "GET", url: "/health" });

  assert.equal(response.statusCode, 200);
  assert.equal(calls.length, 0);
});

void test("public helper routes are rate limited by IP with standard headers", async () => {
  const app = await buildPublicTestServer({ ipLimitPerMinute: 1, windowMs: 60_000 });

  const first = await app.inject({ method: "GET", url: "/openapi.json" });
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers["ratelimit-limit"], "1");
  assert.equal(first.headers["ratelimit-remaining"], "0");
  assert.ok(first.headers["ratelimit-reset"]);
  assert.ok(first.headers["retry-after"]);

  const limited = await app.inject({ method: "GET", url: "/webhook-event-types" });
  assert.equal(limited.statusCode, 429);
  assert.deepEqual(limited.json(), { code: "RATE_LIMITED", message: "rate limit exceeded" });
  assert.equal(limited.headers["ratelimit-limit"], "1");
  assert.equal(limited.headers["ratelimit-remaining"], "0");
  assert.ok(limited.headers["ratelimit-reset"]);
  assert.ok(limited.headers["retry-after"]);
});

void test("public API health and OPTIONS requests do not count against rate limits", async () => {
  const app = await buildPublicTestServer({ ipLimitPerMinute: 1, windowMs: 60_000 });

  for (let i = 0; i < 3; i += 1) {
    const health = await app.inject({ method: "GET", url: "/health" });
    assert.equal(health.statusCode, 200);
    assert.equal(health.headers["ratelimit-limit"], undefined);
  }

  const options = await app.inject({ method: "OPTIONS", url: "/openapi.json" });
  assert.notEqual(options.statusCode, 429);

  const firstCounted = await app.inject({ method: "GET", url: "/openapi.json" });
  assert.equal(firstCounted.statusCode, 200);

  const limited = await app.inject({ method: "GET", url: "/webhook-event-types" });
  assert.equal(limited.statusCode, 429);
});

void test("public API requests without API-key auth are rate limited by IP", async () => {
  const app = await buildPublicTestServer({ ipLimitPerMinute: 1, windowMs: 60_000 });

  const first = await app.inject({ method: "GET", url: "/api/v1/workspaces" });
  assert.equal(first.statusCode, 401);
  assert.equal(first.headers["ratelimit-limit"], "1");
  assert.equal(first.headers["ratelimit-remaining"], "0");

  const limited = await app.inject({ method: "GET", url: "/api/v1/workspaces" });
  assert.equal(limited.statusCode, 429);
  assert.deepEqual(limited.json(), { code: "RATE_LIMITED", message: "rate limit exceeded" });
});

void test("public API rate limiting can be disabled", async () => {
  const app = await buildPublicTestServer({ enabled: false, ipLimitPerMinute: 1, windowMs: 60_000 });

  const first = await app.inject({ method: "GET", url: "/openapi.json" });
  const second = await app.inject({ method: "GET", url: "/webhook-event-types" });

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(second.headers["ratelimit-limit"], undefined);
});
