import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import "./../test/setup.js";
import { AppError, badRequest, notFound, registerErrorHandler } from "./errors.js";
import { configureOpsAlertsForTests } from "./ops-alerts.js";

const apps: FastifyInstance[] = [];

function buildErrorTestServer(): FastifyInstance {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  apps.push(app);
  return app;
}

function parseJsonBody(body: RequestInit["body"] | null | undefined): unknown {
  return typeof body === "string" ? JSON.parse(body) : null;
}

afterEach(async () => {
  configureOpsAlertsForTests(null);
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

void test("Zod errors return the validation response shape", async () => {
  const app = buildErrorTestServer();
  app.post("/validated", async (req) => {
    return z.object({ name: z.string().min(1) }).parse(req.body);
  });

  const response = await app.inject({ method: "POST", url: "/validated", payload: { name: "" } });
  const body = response.json();

  assert.equal(response.statusCode, 400);
  assert.equal(body.code, "VALIDATION");
  assert.equal(body.message, "validation failed");
  assert.equal(body.issues[0].path[0], "name");
});

void test("AppError helpers return their status, code, and message", async () => {
  const app = buildErrorTestServer();
  app.get("/app-error", async () => {
    throw badRequest("nope");
  });

  const response = await app.inject({ method: "GET", url: "/app-error" });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { code: "BAD_REQUEST", message: "nope" });
});

void test("error responses are marked no-store so CDNs do not negative-cache them", async () => {
  // Expired signed-media URLs 404, and Cloudflare negative-caches 4xx for
  // cacheable extensions by default; no-store keeps one expired hit from
  // sticking as an edge 404 for everyone.
  const app = buildErrorTestServer();
  app.get("/app-error", async () => {
    throw badRequest("nope");
  });

  const response = await app.inject({ method: "GET", url: "/app-error" });

  assert.equal(response.headers["cache-control"], "no-store");
});

void test("unexpected errors return the internal error response shape", async () => {
  const app = buildErrorTestServer();
  app.get("/boom", async () => {
    throw new Error("details stay server-side");
  });

  const response = await app.inject({ method: "GET", url: "/boom" });

  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.json(), { code: "INTERNAL", message: "internal error" });
});

void test("Fastify client errors preserve their status and do not emit ops alerts", async () => {
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
  const app = buildErrorTestServer();
  app.post("/cookie-only", async () => ({ ok: true }));

  const response = await app.inject({
    method: "POST",
    url: "/cookie-only",
    headers: { "content-type": "application/x-yaml" },
    payload: "not json",
  });

  assert.equal(response.statusCode, 415);
  assert.deepEqual(response.json(), {
    code: "FST_ERR_CTP_INVALID_MEDIA_TYPE",
    message: "Unsupported Media Type",
  });
  assert.equal(calls.length, 0);
});

void test("unexpected errors emit an ops alert", async () => {
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
  const app = buildErrorTestServer();
  app.get("/boom", async () => {
    throw new Error("details stay server-side");
  });

  const response = await app.inject({ method: "GET", url: "/boom" });

  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.json(), { code: "INTERNAL", message: "internal error" });
  assert.equal(calls.length, 1);
  assert.match(JSON.stringify(calls[0]), /Unhandled API error/);
  assert.match(JSON.stringify(calls[0]), /GET \/boom/);
});

void test("error messages are written in the Accept-Language language without changing code or details", async () => {
  // The web app shows `message` to people and sends its interface language on every request.
  const app = buildErrorTestServer();
  app.get("/missing", async () => {
    throw notFound("board not found");
  });
  app.get("/limit", async () => {
    throw new AppError(403, "PLAN_LIMIT", "Your plan's boards limit has been reached. Upgrade to add more.", { limit: "boards" });
  });
  app.post("/validated", async (req) => z.object({ name: z.string().min(1) }).parse(req.body));

  const missing = await app.inject({ method: "GET", url: "/missing", headers: { "accept-language": "es-MX,es;q=0.9" } });
  assert.deepEqual(missing.json(), { code: "NOT_FOUND", message: "No se encontró el tablero." });

  const limit = await app.inject({ method: "GET", url: "/limit", headers: { "accept-language": "de" } });
  assert.deepEqual(limit.json(), {
    code: "PLAN_LIMIT",
    message: "Das Board-Limit deines Tarifs ist erreicht. Führe ein Upgrade durch, um weitere hinzuzufügen.",
    limit: "boards",
  });

  const validation = await app.inject({ method: "POST", url: "/validated", headers: { "accept-language": "ja" }, payload: { name: "" } });
  assert.equal(validation.json<{ message: string }>().message, "検証に失敗しました。");
  const issue = validation.json<{ issues: { code: string; path: string[]; message: string }[] }>().issues[0]!;
  assert.equal(issue.code, "too_small");
  assert.deepEqual(issue.path, ["name"]);
  assert.match(issue.message, /[\u3040-\u30ff\u4e00-\u9fff]/);

  const media = await app.inject({
    method: "POST",
    url: "/validated",
    headers: { "accept-language": "pt-BR", "content-type": "application/x-yaml" },
    payload: "not json",
  });
  assert.deepEqual(media.json(), { code: "FST_ERR_CTP_INVALID_MEDIA_TYPE", message: "Tipo de mídia não suportado." });
});
