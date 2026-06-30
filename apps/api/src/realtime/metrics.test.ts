import assert from "node:assert/strict";
import { test } from "node:test";
import type { FastifyBaseLogger } from "fastify";
import { logRealtimePublishFailure, setRealtimeLogger } from "./metrics.js";

void test("realtime publish failures are logged with scope and event details", () => {
  const logged: {
    details: Record<string, unknown>;
    message: string;
  }[] = [];
  const log = {
    error(details: Record<string, unknown>, message: string) {
      logged.push({ details, message });
    },
  } as unknown as FastifyBaseLogger;

  const err = new Error("insert failed");
  setRealtimeLogger(log);
  logRealtimePublishFailure(err, {
    scope: "board",
    scopeId: "board-1",
    event: "card:deleted",
  });

  assert.equal(logged[0]?.message, "failed to publish realtime outbox event");
  assert.equal(logged[0]?.details.err, err);
  assert.equal(logged[0]?.details.scope, "board");
  assert.equal(logged[0]?.details.scopeId, "board-1");
  assert.equal(logged[0]?.details.event, "card:deleted");
});
