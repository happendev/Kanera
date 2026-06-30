import assert from "node:assert/strict";
import { test } from "node:test";
import "../test/setup.js";
import { isCandidateOverdue } from "./overdue-notifications.js";

const baseCandidate = {
  userId: "user-1",
  cardId: "card-1",
  listId: "list-1",
  boardId: "board-1",
  workspaceId: "workspace-1",
  dueDateLocalDate: "2026-05-24",
  dueDateSlot: "morning" as const,
  dueDateTimezone: "UTC",
};

void test("cards without a due date are not overdue", () => {
  assert.equal(isCandidateOverdue({ ...baseCandidate, dueDateLocalDate: null }, new Date("2026-05-25T12:00:00Z")), false);
});

void test("past local dates are overdue and future local dates are not", () => {
  assert.equal(isCandidateOverdue(baseCandidate, new Date("2026-05-25T00:00:00Z")), true);
  assert.equal(isCandidateOverdue(baseCandidate, new Date("2026-05-23T23:59:00Z")), false);
});

void test("any-time due dates become overdue at 21:00 in the due date timezone", () => {
  const candidate = { ...baseCandidate, dueDateSlot: "anyTime" as const };

  assert.equal(isCandidateOverdue(candidate, new Date("2026-05-24T20:59:00Z")), false);
  assert.equal(isCandidateOverdue(candidate, new Date("2026-05-24T21:00:00Z")), true);
});

void test("slotted due dates become overdue at their local boundary", () => {
  assert.equal(isCandidateOverdue(baseCandidate, new Date("2026-05-24T08:59:00Z")), false);
  assert.equal(isCandidateOverdue(baseCandidate, new Date("2026-05-24T09:00:00Z")), true);
});

void test("due date checks use the card due date timezone", () => {
  const candidate = { ...baseCandidate, dueDateTimezone: "America/New_York", dueDateSlot: "endOfWorkDay" as const };

  assert.equal(isCandidateOverdue(candidate, new Date("2026-05-24T20:59:00Z")), false);
  assert.equal(isCandidateOverdue(candidate, new Date("2026-05-24T21:00:00Z")), true);
});
