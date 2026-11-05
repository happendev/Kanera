import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import Fastify from "fastify";
import { conditionalCardResponse } from "./conditional-card-response.js";

// A 304 can reach the browser even when Fastify sends twice. Hold an async send hook open so the
// handler-completion race is deterministic and assert the server warnings that E2E cannot see.
void test("conditional card reads finish one response through asynchronous send hooks", async (t) => {
  const messages: string[] = [];
  const app = Fastify({ logger: { level: "warn", stream: { write: (line: string) => { messages.push(line); } } } });
  t.after(() => app.close());
  let sends = 0;
  app.addHook("onSend", async (_req, _reply, payload) => {
    sends++;
    await setImmediate();
    return payload;
  });
  app.get("/card", async (req, reply) => conditionalCardResponse(req, reply, { revision: "7", title: "Card" }));

  const first = await app.inject("/card");
  assert.equal(first.statusCode, 200);
  sends = 0;
  const response = await app.inject({ url: "/card", headers: { "if-none-match": String(first.headers.etag) } });
  await setImmediate();
  assert.equal(response.statusCode, 304);
  assert.equal(response.body, "");
  assert.equal(response.headers["x-card-revision"], "7");
  assert.equal(sends, 1, "only one send hook chain should run for the 304");
  assert.deepEqual(messages, [], "conditional reads must not log double-send warnings or errors");
});
