import assert from "node:assert/strict";
import { test } from "node:test";
import type { NotificationRow } from "@kanera/shared/dto";
import { watchedActivityPushPayload } from "./watched-activity-push.js";

const WEB_ORIGIN = "https://app.kanera.test";

function row(overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: "notification-1",
    userId: "user-1",
    clientId: "client-1",
    activityId: "activity-1",
    cardId: "card-1",
    checklistItemId: null,
    listId: "list-1",
    boardId: "board-1",
    workspaceId: "workspace-1",
    reason: "watching",
    readAt: null,
    createdAt: new Date("2026-08-20T09:00:00.000Z"),
    activity: {
      entityType: "card",
      action: "moved",
      payload: {},
      actorKind: "user",
      actorId: "actor-1",
    },
    actorName: "Dylan",
    cardTitle: "Prepare release",
    cardKey: "PROJ-12",
    organisationKey: "0A1B2C3D4E5F6071",
    listName: "In Progress",
    boardName: "Delivery",
    ...overrides,
  } as NotificationRow;
}

void test("a watched card move reads the same in a push as it does in the drawer", () => {
  const payload = watchedActivityPushPayload(row(), WEB_ORIGIN);
  assert.equal(payload.title, "Prepare release");
  assert.equal(payload.body, "Dylan moved this card to In Progress");
  assert.equal(payload.url, "https://app.kanera.test/o/0A1B2C3D4E5F6071/c/PROJ-12");
  // Collapses repeated activity on one card into a single tray entry.
  assert.equal(payload.tag, "card:card-1:watching");
});

void test("a summary value is appended to the body", () => {
  const payload = watchedActivityPushPayload(row({
    activity: {
      entityType: "card",
      action: "checklist:completed",
      payload: { title: "Final checks", parentItemText: "Ship release" },
      actorKind: "user",
      actorId: "actor-1",
    },
  } as Partial<NotificationRow>), WEB_ORIGIN);
  assert.equal(payload.body, "Dylan completed sub-checklist Final checks on Ship release");
});

void test("self-assignment keeps the drawer's wording", () => {
  const payload = watchedActivityPushPayload(row({
    actorName: "Amelia Hart",
    activity: {
      entityType: "card",
      action: "assignees:set",
      payload: { addedAssigneeNames: ["Amelia Hart"] },
      actorKind: "user",
      actorId: "actor-1",
    },
  } as Partial<NotificationRow>), WEB_ORIGIN);
  assert.equal(payload.body, "Amelia Hart assigned themself");
});

void test("an unknown action falls back to a humanised label rather than dropping the push", () => {
  const payload = watchedActivityPushPayload(row({
    activity: {
      entityType: "card",
      action: "someNew:action",
      payload: {},
      actorKind: "user",
      actorId: "actor-1",
    },
  } as Partial<NotificationRow>), WEB_ORIGIN);
  assert.equal(payload.body, "Dylan some new action");
});

void test("a missing actor and card title still produce a sendable notification", () => {
  const payload = watchedActivityPushPayload(row({ actorName: null, cardTitle: null }), WEB_ORIGIN);
  assert.equal(payload.title, "Delivery");
  assert.equal(payload.body, "Someone moved this card to In Progress");
});
