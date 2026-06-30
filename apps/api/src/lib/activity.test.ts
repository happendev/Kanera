import type { ActivityEvent } from "@kanera/shared/schema";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mock, test } from "node:test";
import { toActivityFeedEvent } from "./activity.js";

void test("toActivityFeedEvent signs actor avatar URLs", () => {
  const clock = mock.method(Date, "now", () => 1_700_000_001_000);
  try {
    const activity: ActivityEvent = {
      id: randomUUID(),
      boardId: randomUUID(),
      workspaceId: randomUUID(),
      actorId: randomUUID(),
      actorKind: "user",
      apiKeyId: null,
      apiKeyName: null,
      entityType: "card",
      entityId: randomUUID(),
      action: "completed",
      payload: {},
      feedVisible: true,
      coalesceKey: null,
      coalescedCount: 1,
      coalescedUntil: null,
      createdAt: new Date("2026-05-25T12:00:00.000Z"),
      updatedAt: new Date("2026-05-25T12:00:00.000Z"),
    };

    const event = toActivityFeedEvent(
      activity,
      { displayName: "Ada", avatarUrl: "/api/media/client-1/avatars/ada.jpg" },
      "client-1",
    );

    assert.equal(event.actorName, "Ada");
    assert.ok(event.actorAvatarUrl);
    const signed = new URL(event.actorAvatarUrl);
    assert.equal(signed.pathname, "/api/media/client-1/avatars/ada.jpg");
    assert.ok(signed.searchParams.get("t"));
    assert.ok(signed.searchParams.get("e"));
  } finally {
    clock.mock.restore();
  }
});

void test("toActivityFeedEvent uses API key attribution when present", () => {
  const activity: ActivityEvent = {
    id: randomUUID(),
    boardId: randomUUID(),
    workspaceId: randomUUID(),
    actorId: randomUUID(),
    actorKind: "apiKey",
    apiKeyId: randomUUID(),
    apiKeyName: "Zapier sync",
    entityType: "card",
    entityId: randomUUID(),
    action: "created",
    payload: {},
    feedVisible: true,
    coalesceKey: null,
    coalescedCount: 1,
    coalescedUntil: null,
    createdAt: new Date("2026-05-25T12:00:00.000Z"),
    updatedAt: new Date("2026-05-25T12:00:00.000Z"),
  };

  const event = toActivityFeedEvent(
    activity,
    { displayName: "Ada", avatarUrl: "/api/media/client-1/avatars/ada.jpg" },
    "client-1",
  );

  assert.equal(event.actorName, "Zapier sync");
  assert.equal(event.actorAvatarUrl, null);
});
