import assert from "node:assert/strict";
import test from "node:test";
import { KaneraHttpClient } from "./client.js";
import { KaneraApiError, KaneraConnectionError } from "./errors.js";

interface Call { url: string; init: RequestInit }

function stub(responses: (Response | (() => Response))[]) {
  const calls: Call[] = [];
  let index = 0;
  const fetchImpl = ((url: string | URL, init?: RequestInit) => {
    calls.push({ url: url instanceof URL ? url.toString() : url, init: init ?? {} });
    const next = responses[Math.min(index++, responses.length - 1)]!;
    const response = typeof next === "function" ? next() : next;
    return Promise.resolve(response);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function client(fetchImpl: typeof fetch, overrides = {}) {
  return new KaneraHttpClient({ apiKey: "kanera_u_test", baseUrl: "https://api.example.test", fetch: fetchImpl, maxRetries: 2, ...overrides });
}

void test("sends the credential, accept, and provenance headers", async () => {
  const { calls, fetchImpl } = stub([json({ ok: true })]);
  await client(fetchImpl).get("/api/v1/session");
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer kanera_u_test");
  assert.equal(headers["x-kanera-client"], "sdk");
  assert.match(headers["user-agent"]!, /^kanera-sdk\//u);
});

void test("array query values repeat the key rather than joining", async () => {
  const { calls, fetchImpl } = stub([json([])]);
  await client(fetchImpl).get("/api/v1/boards", { query: { ids: ["a", "b"], limit: 10, skip: undefined } });
  assert.equal(calls[0]!.url, "https://api.example.test/api/v1/boards?ids=a&ids=b&limit=10");
});

void test("a problem document becomes a typed error", async () => {
  const { fetchImpl } = stub([json({ code: "FORBIDDEN", message: "write-capable credential required" }, 403)]);
  const error = await client(fetchImpl).patch("/api/v1/cards/x", { title: "y" }).catch((e: unknown) => e);
  assert.ok(error instanceof KaneraApiError);
  assert.equal(error.code, "FORBIDDEN");
  assert.ok(error.isForbidden);
  assert.equal(error.isRetryable, false);
});

void test("a mutation without an idempotency key is never retried", async () => {
  // Retrying an unkeyed POST after an ambiguous failure would post the comment twice.
  const { calls, fetchImpl } = stub([json({ code: "INTERNAL", message: "boom" }, 500)]);
  await client(fetchImpl).post("/api/v1/cards/x/comments", { body: "hi" }).catch(() => undefined);
  assert.equal(calls.length, 1);
});

void test("a mutation with an idempotency key is retried and forwards the key", async () => {
  const { calls, fetchImpl } = stub([
    () => json({ code: "INTERNAL", message: "boom" }, 500),
    () => json({ id: "c1" }),
  ]);
  const result = await client(fetchImpl).post<{ id: string }>("/api/v1/cards/x/comments", { body: "hi" }, {
    idempotencyKey: "11111111-1111-4111-8111-111111111111",
  });
  assert.equal(result.id, "c1");
  assert.equal(calls.length, 2);
  assert.equal((calls[0]!.init.headers as Record<string, string>)["idempotency-key"], "11111111-1111-4111-8111-111111111111");
});

void test("reads are retried on rate limits and honour Retry-After", async () => {
  const { calls, fetchImpl } = stub([
    () => json({ code: "RATE_LIMITED", message: "slow down" }, 429, { "retry-after": "0" }),
    () => json({ userId: "u1" }),
  ]);
  const result = await client(fetchImpl).get<{ userId: string }>("/api/v1/session");
  assert.equal(result.userId, "u1");
  assert.equal(calls.length, 2);
});

void test("retries stop at maxRetries and surface the last error", async () => {
  const { calls, fetchImpl } = stub([() => json({ code: "INTERNAL", message: "boom" }, 500)]);
  const error = await client(fetchImpl, { maxRetries: 1 }).get("/api/v1/session").catch((e: unknown) => e);
  assert.ok(error instanceof KaneraApiError);
  assert.equal(calls.length, 2);
});

void test("a 403 is not retried", async () => {
  const { calls, fetchImpl } = stub([() => json({ code: "FORBIDDEN", message: "nope" }, 403)]);
  await client(fetchImpl).get("/api/v1/session").catch(() => undefined);
  assert.equal(calls.length, 1);
});

void test("a transport failure becomes a connection error", async () => {
  const fetchImpl = (() => Promise.reject(new TypeError("network down"))) as unknown as typeof fetch;
  const error = await client(fetchImpl, { maxRetries: 0 }).get("/api/v1/session").catch((e: unknown) => e);
  assert.ok(error instanceof KaneraConnectionError);
});

void test("a caller's own abort surfaces as itself, not as a Kanera timeout", async () => {
  const controller = new AbortController();
  const fetchImpl = ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  })) as unknown as typeof fetch;
  const pending = client(fetchImpl, { maxRetries: 0 }).get("/api/v1/session", { signal: controller.signal });
  controller.abort();
  const error = await pending.catch((e: unknown) => e);
  assert.ok(!(error instanceof KaneraConnectionError));
});

void test("retryAfterMs accepts both delta-seconds and HTTP-date", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(new KaneraApiError(429, "RATE_LIMITED", "", { retryAfter: "30" }).retryAfterMs(now), 30_000);
  assert.equal(
    new KaneraApiError(429, "RATE_LIMITED", "", { retryAfter: "Thu, 01 Jan 2026 00:00:10 GMT" }).retryAfterMs(now),
    10_000,
  );
  assert.equal(new KaneraApiError(429, "RATE_LIMITED", "", {}).retryAfterMs(now), null);
});
