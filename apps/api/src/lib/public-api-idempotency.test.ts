import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import type { RedisClient } from "../redis.js";
import { registerErrorHandler } from "./errors.js";
import { registerPublicApiIdempotency } from "./public-api-idempotency.js";

class MemoryRedis {
  private readonly values = new Map<string, string>();

  async set(key: string, value: string, ...args: string[]) {
    if (args.includes("NX") && this.values.has(key)) return null;
    this.values.set(key, value);
    return "OK";
  }

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async del(key: string) {
    return this.values.delete(key) ? 1 : 0;
  }
}

async function buildServer() {
  const app = Fastify({ logger: false });
  let writes = 0;
  app.addHook("preHandler", async (req) => {
    req.auth = { sub: "user-1", cid: "client-1", role: "member", apiKeyId: "key-1" };
  });
  registerPublicApiIdempotency(app, { redis: new MemoryRedis() as unknown as RedisClient });
  registerErrorHandler(app, { service: "public-api" });
  app.post("/items", async (req, reply) => {
    writes += 1;
    return reply.status(201).send({ writes, body: req.body });
  });
  await app.ready();
  return { app, writes: () => writes };
}

void test("replays an idempotent JSON mutation without running its handler twice", async () => {
  const { app, writes } = await buildServer();
  const request = {
    method: "POST" as const,
    url: "/items",
    headers: { "idempotency-key": "create-item-1" },
    payload: { title: "First" },
  };

  const first = await app.inject(request);
  const replay = await app.inject(request);

  assert.equal(first.statusCode, 201);
  assert.deepEqual(replay.json(), first.json());
  assert.equal(replay.headers["idempotency-replayed"], "true");
  assert.equal(writes(), 1);
  await app.close();
});

void test("rejects reuse of an idempotency key for a different request", async () => {
  const { app, writes } = await buildServer();
  await app.inject({
    method: "POST",
    url: "/items",
    headers: { "idempotency-key": "create-item-1" },
    payload: { title: "First" },
  });
  const conflict = await app.inject({
    method: "POST",
    url: "/items",
    headers: { "idempotency-key": "create-item-1" },
    payload: { title: "Different" },
  });

  assert.equal(conflict.statusCode, 409);
  assert.deepEqual(conflict.json(), { code: "CONFLICT", message: "Idempotency-Key was already used for a different request" });
  assert.equal(writes(), 1);
  await app.close();
});
