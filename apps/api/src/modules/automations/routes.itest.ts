import "../../test/setup.integration.js";
import { AUTOMATION_LIMIT } from "@kanera/shared/automation-limits";
import {
  AUTOMATION_ACTION_LIMIT,
  type AutomationActionBody,
} from "@kanera/shared/dto";
import {
  ACTIVITY_ACTION,
  activityEvents,
  automationActions,
  automationDueDateRuns,
  automationRunStats,
  automations,
  boardMembers,
  boardWatchers,
  boards,
  cardAssignees,
  cardChecklistItems,
  cardChecklists,
  cardChecklistTemplateApplications,
  cardLabelAssignments,
  cardLabels,
  checklistTemplates,
  cardWatchers,
  cards,
  cardCustomFieldValues,
  customFieldOptions,
  emailQueue,
  lists,
  notifications,
  users,
  customFields,
  workspaceMembers,
} from "@kanera/shared/schema";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import assert from "node:assert/strict";
import { test } from "node:test";
import { db, pool } from "../../db.js";
import { runDueDateAutomationSweep, runListEntryAutomations } from "../../lib/automations.js";
import { waitForNotificationFanoutForTests } from "../../lib/notifications.js";
import { buildIntegrationServer } from "../../test/integration.js";

function completionActions(count: number): AutomationActionBody[] {
  return Array.from({ length: count }, () => ({ type: "set_completion", config: { completed: true } }));
}

async function setupWorkspace(email: string) {
  const app = await buildIntegrationServer();
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Automation",
      email,
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<{ accessToken: string; user: { id: string; clientId: string } }>();
  const auth = { authorization: `Bearer ${accessToken}` };

  const created = await app.inject({ method: "POST", url: "/workspaces", headers: auth, payload: { name: "Delivery" } });
  assert.equal(created.statusCode, 201);
  const workspace = created.json<{ id: string }>();
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Board", position: "1000.0000000000" })
    .returning();
  assert.ok(board);

  return { app, auth, user, workspace, list, board };
}

async function addWorkspaceMember(f: Awaited<ReturnType<typeof setupWorkspace>>, email: string, displayName: string) {
  const [user] = await db
    .insert(users)
    .values({ clientId: f.user.clientId, email, passwordHash: "x", displayName })
    .returning();
  assert.ok(user);
  await db.insert(workspaceMembers).values({ workspaceId: f.workspace.id, userId: user.id, role: "member" });
  // Board membership is the access model: seed a board_member row so the member can act on, be
  // assigned to, and be notified about the fixture board (mirrors seeding on real board creation).
  await db.insert(boardMembers).values({ boardId: f.board.id, userId: user.id, role: "editor" });
  const token = f.app.jwt.sign({ sub: user.id, cid: f.user.clientId, role: "member" });
  return { user, auth: { authorization: `Bearer ${token}` } };
}

function currentUtcMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function currentUtcDate(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
}

async function loadAutomationRunStats(automationId: string) {
  const [stats] = await db.select().from(automationRunStats).where(eq(automationRunStats.automationId, automationId)).limit(1);
  return stats;
}

void test("automation run stats count one effectful run per matched automation evaluation", async () => {
  const f = await setupWorkspace("owner-automation-stats-effectful@example.com");
  const [label] = await db
    .insert(cardLabels)
    .values({ workspaceId: f.workspace.id, name: "Escalated", position: "1000.0000000000" })
    .returning();
  assert.ok(label);
  const [card] = await db
    .insert(cards)
    .values({ boardId: f.board.id, listId: f.list.id, title: "Stats effectful", position: "1000.0000000000", createdById: f.user.id })
    .returning();
  assert.ok(card);
  const [automation] = await db
    .insert(automations)
    .values({ workspaceId: f.workspace.id, enabled: true, position: "1000.0000000000", triggerType: "card_enters_list", triggerListId: f.list.id })
    .returning();
  assert.ok(automation);
  await db.insert(automationActions).values([
    {
      automationId: automation.id,
      type: "add_labels",
      position: "1000.0000000000",
      config: { labelIds: [label.id] },
    },
    {
      automationId: automation.id,
      type: "set_completion",
      position: "2000.0000000000",
      config: { completed: true },
    },
  ]);

  const result = await runListEntryAutomations(db, {
    cardId: card.id,
    listId: f.list.id,
    boardId: f.board.id,
    workspaceId: f.workspace.id,
    clientId: f.user.clientId,
    trigger: "create",
  });

  assert.equal(result.effects.length, 2);
  const stats = await loadAutomationRunStats(automation.id);
  assert.ok(stats);
  assert.equal(stats.runCount, 1);
  assert.equal(stats.effectfulRunCount, 1);
  assert.equal(stats.noopRunCount, 0);
  assert.equal(stats.failedRunCount, 0);
  assert.ok(stats.lastRunAt);
  assert.ok(stats.lastEffectfulRunAt);
  assert.equal(stats.lastNoopRunAt, null);
  assert.equal(stats.lastFailedRunAt, null);
});

void test("automation run stats count matched no-op evaluations", async () => {
  const f = await setupWorkspace("owner-automation-stats-noop@example.com");
  const [card] = await db
    .insert(cards)
    .values({
      boardId: f.board.id,
      listId: f.list.id,
      title: "Stats no-op",
      position: "1000.0000000000",
      createdById: f.user.id,
      completedAt: new Date(),
    })
    .returning();
  assert.ok(card);
  const [automation] = await db
    .insert(automations)
    .values({ workspaceId: f.workspace.id, enabled: true, position: "1000.0000000000", triggerType: "card_enters_list", triggerListId: f.list.id })
    .returning();
  assert.ok(automation);
  await db.insert(automationActions).values({
    automationId: automation.id,
    type: "set_completion",
    position: "1000.0000000000",
    config: { completed: true },
  });

  const result = await runListEntryAutomations(db, {
    cardId: card.id,
    listId: f.list.id,
    boardId: f.board.id,
    workspaceId: f.workspace.id,
    clientId: f.user.clientId,
    trigger: "create",
  });

  assert.equal(result.effects.length, 0);
  const stats = await loadAutomationRunStats(automation.id);
  assert.ok(stats);
  assert.equal(stats.runCount, 1);
  assert.equal(stats.effectfulRunCount, 0);
  assert.equal(stats.noopRunCount, 1);
  assert.equal(stats.failedRunCount, 0);
  assert.ok(stats.lastRunAt);
  assert.equal(stats.lastEffectfulRunAt, null);
  assert.ok(stats.lastNoopRunAt);
  assert.equal(stats.lastFailedRunAt, null);
});

void test("due date automation run stats do not increment when the due-date guard skips", async () => {
  const f = await setupWorkspace("owner-automation-stats-due-date@example.com");
  const [automation] = await db
    .insert(automations)
    .values({
      workspaceId: f.workspace.id,
      enabled: true,
      position: "1000.0000000000",
      triggerType: "due_date_arrives",
    })
    .returning();
  assert.ok(automation);
  await db.insert(automationActions).values({
    automationId: automation.id,
    type: "set_due_date",
    position: "1000.0000000000",
    config: { offsetDays: 1, slot: "anyTime" },
  });
  const [card] = await db
    .insert(cards)
    .values({
      boardId: f.board.id,
      listId: f.list.id,
      title: "Stats due date",
      position: "1000.0000000000",
      createdById: f.user.id,
      dueDateLocalDate: "2026-05-20",
      dueDateSlot: "anyTime",
      dueDateTimezone: "UTC",
    })
    .returning();
  assert.ok(card);

  const firstRunCount = await runDueDateAutomationSweep(undefined, new Date("2026-05-21T12:00:00.000Z"));
  assert.equal(firstRunCount, 1);
  const afterFirst = await loadAutomationRunStats(automation.id);
  assert.ok(afterFirst);
  assert.equal(afterFirst.runCount, 1);
  assert.equal(afterFirst.effectfulRunCount, 1);

  const secondRunCount = await runDueDateAutomationSweep(undefined, new Date("2026-05-21T12:00:00.000Z"));
  assert.equal(secondRunCount, 0);
  const afterSecond = await loadAutomationRunStats(automation.id);
  assert.ok(afterSecond);
  assert.equal(afterSecond.runCount, 1);
  assert.equal(afterSecond.effectfulRunCount, 1);
  const runs = await db.select().from(automationDueDateRuns).where(eq(automationDueDateRuns.automationId, automation.id));
  assert.equal(runs.length, 1);
});

void test("automation routes reject missing card-entered list trigger targets", async () => {
  const f = await setupWorkspace("owner-automation-trigger-validation@example.com");

  const createMissingList = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      triggerType: "card_enters_list",
      actions: [],
    },
  });
  assert.equal(createMissingList.statusCode, 400);

  const dueAutomation = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      enabled: false,
      triggerType: "due_date_arrives",
      actions: [],
    },
  });
  assert.equal(dueAutomation.statusCode, 201);

  const rejectNullList = await f.app.inject({
    method: "PATCH",
    url: `/automations/${dueAutomation.json<{ id: string }>().id}`,
    headers: f.auth,
    payload: { triggerType: "card_enters_list", triggerListId: null },
  });
  assert.equal(rejectNullList.statusCode, 400);
});

void test("automation routes validate label-set trigger targets", async () => {
  const f = await setupWorkspace("owner-automation-label-trigger-validation@example.com");
  const other = await setupWorkspace("owner-automation-label-trigger-other@example.com");
  const [label] = await db
    .insert(cardLabels)
    .values({ workspaceId: f.workspace.id, name: "Urgent", position: "1000.0000000000" })
    .returning();
  const [otherLabel] = await db
    .insert(cardLabels)
    .values({ workspaceId: other.workspace.id, name: "Other", position: "1000.0000000000" })
    .returning();
  const [deletedLabel] = await db
    .insert(cardLabels)
    .values({ workspaceId: f.workspace.id, name: "Deleted", position: "2000.0000000000" })
    .returning();
  assert.ok(label);
  assert.ok(otherLabel);
  assert.ok(deletedLabel);
  await db.delete(cardLabels).where(eq(cardLabels.id, deletedLabel.id));

  const missing = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      triggerType: "card_label_set",
      actions: [],
    },
  });
  assert.equal(missing.statusCode, 400);

  for (const triggerLabelId of [otherLabel.id, deletedLabel.id]) {
    const invalid = await f.app.inject({
      method: "POST",
      url: `/workspaces/${f.workspace.id}/automations`,
      headers: f.auth,
      payload: {
        triggerType: "card_label_set",
        triggerLabelId,
        actions: [],
      },
    });
    assert.equal(invalid.statusCode, 400);
  }

  const created = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      enabled: false,
      triggerType: "card_label_set",
      triggerLabelId: label.id,
      actions: [],
    },
  });
  assert.equal(created.statusCode, 201);

  const rejectCleared = await f.app.inject({
    method: "PATCH",
    url: `/automations/${created.json<{ id: string }>().id}`,
    headers: f.auth,
    payload: { triggerLabelId: null },
  });
  assert.equal(rejectCleared.statusCode, 400);
});

void test("automation routes prevent enabled automations without actions", async () => {
  const f = await setupWorkspace("owner-automation-empty-actions-validation@example.com");

  const createEnabledEmpty = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      enabled: true,
      triggerType: "card_enters_list",
      triggerListId: f.list.id,
      actions: [],
    },
  });
  assert.equal(createEnabledEmpty.statusCode, 400);

  const createDefaultDisabled = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      triggerType: "card_enters_list",
      triggerListId: f.list.id,
      actions: [{ type: "set_completion", config: { completed: true } }],
    },
  });
  assert.equal(createDefaultDisabled.statusCode, 201);
  assert.equal(createDefaultDisabled.json<{ enabled: boolean }>().enabled, false);

  const createDisabledEmpty = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      enabled: false,
      triggerType: "card_enters_list",
      triggerListId: f.list.id,
      actions: [],
    },
  });
  assert.equal(createDisabledEmpty.statusCode, 201);
  const automationId = createDisabledEmpty.json<{ id: string }>().id;
  const emptyActions = await db.select({ id: automationActions.id }).from(automationActions).where(eq(automationActions.automationId, automationId));
  assert.equal(emptyActions.length, 0);

  const enableEmpty = await f.app.inject({
    method: "PATCH",
    url: `/automations/${automationId}`,
    headers: f.auth,
    payload: { enabled: true },
  });
  assert.equal(enableEmpty.statusCode, 400);

  const addAction = await f.app.inject({
    method: "PUT",
    url: `/automations/${automationId}/actions`,
    headers: f.auth,
    payload: { actions: [{ type: "set_completion", config: { completed: true } }] },
  });
  assert.equal(addAction.statusCode, 200);

  const enableWithAction = await f.app.inject({
    method: "PATCH",
    url: `/automations/${automationId}`,
    headers: f.auth,
    payload: { enabled: true },
  });
  assert.equal(enableWithAction.statusCode, 200);
  assert.equal(enableWithAction.json<{ enabled: boolean }>().enabled, true);

  const clearActions = await f.app.inject({
    method: "PUT",
    url: `/automations/${automationId}/actions`,
    headers: f.auth,
    payload: { actions: [] },
  });
  assert.equal(clearActions.statusCode, 200);
  assert.equal(clearActions.json<{ enabled: boolean; actions: unknown[] }>().enabled, false);
  assert.equal(clearActions.json<{ enabled: boolean; actions: unknown[] }>().actions.length, 0);
});

void test("automation routes limit each automation to five actions", async () => {
  const f = await setupWorkspace("owner-automation-action-limit@example.com");

  const createAtLimit = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      triggerType: "card_enters_list",
      triggerListId: f.list.id,
      actions: completionActions(AUTOMATION_ACTION_LIMIT),
    },
  });
  assert.equal(createAtLimit.statusCode, 201);
  assert.equal(createAtLimit.json<{ actions: unknown[] }>().actions.length, AUTOMATION_ACTION_LIMIT);

  const createAboveLimit = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      triggerType: "card_enters_list",
      triggerListId: f.list.id,
      actions: completionActions(AUTOMATION_ACTION_LIMIT + 1),
    },
  });
  assert.equal(createAboveLimit.statusCode, 400);

  const updateAboveLimit = await f.app.inject({
    method: "PUT",
    url: `/automations/${createAtLimit.json<{ id: string }>().id}/actions`,
    headers: f.auth,
    payload: { actions: completionActions(AUTOMATION_ACTION_LIMIT + 1) },
  });
  assert.equal(updateAboveLimit.statusCode, 400);
});

void test("automation routes limit each workspace to thirty automations", async () => {
  const f = await setupWorkspace("owner-automation-count-limit@example.com");
  await db.insert(automations).values(
    Array.from({ length: AUTOMATION_LIMIT }, (_, index) => ({
      workspaceId: f.workspace.id,
      enabled: false,
      position: `${index + 1}000.0000000000`,
      triggerType: "card_enters_list" as const,
      triggerListId: f.list.id,
    })),
  );

  const res = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      triggerType: "card_enters_list",
      triggerListId: f.list.id,
      actions: completionActions(1),
    },
  });

  assert.equal(res.statusCode, 400);
  assert.match(res.json<{ message: string }>().message, /Contact support/u);
});

void test("automation routes place newly created automations at the top", async () => {
  const f = await setupWorkspace("owner-automation-create-top@example.com");

  const first = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      triggerType: "card_enters_list",
      triggerListId: f.list.id,
      actions: [{ type: "set_completion", config: { completed: true } }],
    },
  });
  assert.equal(first.statusCode, 201);

  const second = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      triggerType: "card_enters_list",
      triggerListId: f.list.id,
      actions: [{ type: "clear_due_date", config: {} }],
    },
  });
  assert.equal(second.statusCode, 201);

  const automationsList = await f.app.inject({
    method: "GET",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
  });
  assert.equal(automationsList.statusCode, 200);
  assert.deepEqual(
    automationsList.json<Array<{ id: string }>>().map((automation) => automation.id),
    [second.json<{ id: string }>().id, first.json<{ id: string }>().id],
  );
});

void test("automation routes reject invalid action targets", async () => {
  const f = await setupWorkspace("owner-automation-target-validation@example.com");
  const missingId = "00000000-0000-4000-8000-000000000001";

  for (const action of [
    { type: "move_to_list", config: { listId: missingId } },
    { type: "add_labels", config: { labelIds: [missingId] } },
    { type: "add_assignees", config: { userIds: [missingId] } },
    { type: "add_labels", config: { labelIds: [] } },
    { type: "add_assignees", config: { userIds: [] } },
  ]) {
    const res = await f.app.inject({
      method: "POST",
      url: `/workspaces/${f.workspace.id}/automations`,
      headers: f.auth,
      payload: {
        name: `Invalid ${action.type}`,
        triggerType: "card_enters_list",
        triggerListId: f.list.id,
        actions: [action],
      },
    });
    assert.equal(res.statusCode, 400);
  }
});

void test("automation routes reject invalid checklist template action targets", async () => {
  const f = await setupWorkspace("owner-automation-checklist-target-validation@example.com");
  const missingId = "00000000-0000-0000-0000-000000000123";
  const res = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      triggerType: "card_enters_list",
      triggerListId: f.list.id,
      actions: [{ type: "apply_checklists", config: { templateIds: [missingId] } }],
    },
  });
  assert.equal(res.statusCode, 400);
});

void test("automation routes reject invalid set custom field targets", async () => {
  const f = await setupWorkspace("owner-automation-populate-field-target-validation@example.com");
  const missingId = "00000000-0000-0000-0000-000000000456";
  const [numberField] = await db
    .insert(customFields)
    .values({ workspaceId: f.workspace.id, name: "Hours", icon: "number", type: "number", position: "1000.0000000000" })
    .returning();
  assert.ok(numberField);

  for (const fieldId of [missingId, numberField.id]) {
    const res = await f.app.inject({
      method: "POST",
      url: `/workspaces/${f.workspace.id}/automations`,
      headers: f.auth,
      payload: {
        triggerType: "card_enters_list",
        triggerListId: f.list.id,
        actions: [{ type: "populate_custom_field", config: { fieldId, onlyIfEmpty: true, value: { kind: "text_current_date", format: "month" } } }],
      },
    });
    assert.equal(res.statusCode, 400);
  }
});

void test("automation routes reject empty set custom field text", async () => {
  const f = await setupWorkspace("owner-automation-populate-format-validation@example.com");
  const [field] = await db
    .insert(customFields)
    .values({ workspaceId: f.workspace.id, name: "Billing Month", icon: "calendar", type: "text", position: "1000.0000000000" })
    .returning();
  assert.ok(field);

  for (const config of [
    { fieldId: field.id, onlyIfEmpty: true, value: { kind: "date", source: "current" } },
    { fieldId: field.id, onlyIfEmpty: true, value: { kind: "text", text: "" } },
  ]) {
    const res = await f.app.inject({
      method: "POST",
      url: `/workspaces/${f.workspace.id}/automations`,
      headers: f.auth,
      payload: {
        triggerType: "card_enters_list",
        triggerListId: f.list.id,
        actions: [{ type: "populate_custom_field", config }],
      },
    });
    assert.equal(res.statusCode, 400);
  }
});

void test("list-entry automation populates an empty text custom field with the current month", async () => {
  const f = await setupWorkspace("owner-automation-populate-billing-month@example.com");
  const [field] = await db
    .insert(customFields)
    .values({ workspaceId: f.workspace.id, name: "Billing Month", icon: "calendar", type: "text", position: "1000.0000000000" })
    .returning();
  assert.ok(field);

  const automation = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      enabled: true,
      triggerType: "card_enters_list",
      triggerListId: f.list.id,
      applyOnCreate: true,
      applyOnMove: true,
      actions: [{ type: "populate_custom_field", config: { fieldId: field.id, onlyIfEmpty: true, value: { kind: "text_current_date", format: "month" } } }],
    },
  });
  assert.equal(automation.statusCode, 201);

  const created = await f.app.inject({
    method: "POST",
    url: `/boards/${f.board.id}/lists/${f.list.id}/cards`,
    headers: f.auth,
    payload: { title: "Billable card" },
  });
  assert.equal(created.statusCode, 201);
  const card = created.json<{ id: string }>();

  const [value] = await db
    .select()
    .from(cardCustomFieldValues)
    .where(and(eq(cardCustomFieldValues.cardId, card.id), eq(cardCustomFieldValues.fieldId, field.id)))
    .limit(1);
  assert.equal(value?.valueText, currentUtcMonth());

  const [activity] = await db
    .select()
    .from(activityEvents)
    .where(and(eq(activityEvents.entityId, card.id), eq(activityEvents.action, ACTIVITY_ACTION.CUSTOM_FIELD_VALUE_SET)))
    .limit(1);
  assert.equal((activity?.payload as { fieldName?: string; toValue?: string; automationActionId?: string } | undefined)?.fieldName, "Billing Month");
  assert.equal((activity?.payload as { fieldName?: string; toValue?: string; automationActionId?: string } | undefined)?.toValue, currentUtcMonth());
  assert.ok((activity?.payload as { fieldName?: string; toValue?: string; automationActionId?: string } | undefined)?.automationActionId);
});

void test("set custom field automation preserves existing text values", async () => {
  const f = await setupWorkspace("owner-automation-populate-preserve-existing@example.com");
  const [field] = await db
    .insert(customFields)
    .values({ workspaceId: f.workspace.id, name: "Billing Month", icon: "calendar", type: "text", position: "1000.0000000000" })
    .returning();
  assert.ok(field);

  const automation = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      enabled: true,
      triggerType: "card_enters_list",
      triggerListId: f.list.id,
      applyOnCreate: false,
      applyOnMove: true,
      actions: [{ type: "populate_custom_field", config: { fieldId: field.id, onlyIfEmpty: true, value: { kind: "text_current_date", format: "month" } } }],
    },
  });
  assert.equal(automation.statusCode, 201);

  const [otherList] = await db.select().from(lists).where(and(eq(lists.workspaceId, f.workspace.id), ne(lists.id, f.list.id))).limit(1);
  assert.ok(otherList);
  const [card] = await db
    .insert(cards)
    .values({ boardId: f.board.id, listId: otherList.id, title: "Manual month", position: "1000.0000000000", createdById: f.user.id })
    .returning();
  assert.ok(card);
  await db.insert(cardCustomFieldValues).values({ cardId: card.id, fieldId: field.id, valueText: "manual" });

  const moved = await f.app.inject({
    method: "POST",
    url: `/cards/${card.id}/move`,
    headers: f.auth,
    payload: { listId: f.list.id, afterCardId: null },
  });
  assert.equal(moved.statusCode, 200);

  const [value] = await db
    .select()
    .from(cardCustomFieldValues)
    .where(and(eq(cardCustomFieldValues.cardId, card.id), eq(cardCustomFieldValues.fieldId, field.id)))
    .limit(1);
  assert.equal(value?.valueText, "manual");
});

void test("list-entry automation populates literal text into a custom field", async () => {
  const f = await setupWorkspace("owner-automation-populate-literal-text@example.com");
  const [field] = await db
    .insert(customFields)
    .values({ workspaceId: f.workspace.id, name: "Billing Status", icon: "forms", type: "text", position: "1000.0000000000" })
    .returning();
  assert.ok(field);

  const automation = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      enabled: true,
      triggerType: "card_enters_list",
      triggerListId: f.list.id,
      applyOnCreate: true,
      applyOnMove: true,
      actions: [{ type: "populate_custom_field", config: { fieldId: field.id, onlyIfEmpty: true, value: { kind: "text", text: "Ready to bill" } } }],
    },
  });
  assert.equal(automation.statusCode, 201);

  const created = await f.app.inject({
    method: "POST",
    url: `/boards/${f.board.id}/lists/${f.list.id}/cards`,
    headers: f.auth,
    payload: { title: "Billable card" },
  });
  assert.equal(created.statusCode, 201);
  const card = created.json<{ id: string }>();

  const [value] = await db
    .select()
    .from(cardCustomFieldValues)
    .where(and(eq(cardCustomFieldValues.cardId, card.id), eq(cardCustomFieldValues.fieldId, field.id)))
    .limit(1);
  assert.equal(value?.valueText, "Ready to bill");
});

void test("list-entry automation sets date, checkbox, select, and user custom fields", async () => {
  const f = await setupWorkspace("owner-automation-set-typed-fields@example.com");
  const [dateField, checkboxField, selectField, userField] = await db
    .insert(customFields)
    .values([
      { workspaceId: f.workspace.id, name: "Billing Date", icon: "calendar", type: "date", position: "1000.0000000000" },
      { workspaceId: f.workspace.id, name: "Billable", icon: "checkbox", type: "checkbox", position: "2000.0000000000" },
      { workspaceId: f.workspace.id, name: "Status", icon: "selector", type: "select", position: "3000.0000000000" },
      { workspaceId: f.workspace.id, name: "Reviewer", icon: "user", type: "user", position: "4000.0000000000" },
    ])
    .returning();
  assert.ok(dateField);
  assert.ok(checkboxField);
  assert.ok(selectField);
  assert.ok(userField);
  const [doneOption] = await db
    .insert(customFieldOptions)
    .values({ fieldId: selectField.id, label: "Done", position: "1000.0000000000" })
    .returning();
  assert.ok(doneOption);

  const automation = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      enabled: true,
      triggerType: "card_enters_list",
      triggerListId: f.list.id,
      actions: [
        { type: "populate_custom_field", config: { fieldId: dateField.id, onlyIfEmpty: true, value: { kind: "date", source: "current" } } },
        { type: "populate_custom_field", config: { fieldId: checkboxField.id, onlyIfEmpty: true, value: { kind: "checkbox", checked: false } } },
        { type: "populate_custom_field", config: { fieldId: selectField.id, onlyIfEmpty: true, value: { kind: "select", optionIds: [doneOption.id] } } },
        { type: "populate_custom_field", config: { fieldId: userField.id, onlyIfEmpty: true, value: { kind: "user", userIds: [f.user.id] } } },
      ],
    },
  });
  assert.equal(automation.statusCode, 201);

  const created = await f.app.inject({
    method: "POST",
    url: `/boards/${f.board.id}/lists/${f.list.id}/cards`,
    headers: f.auth,
    payload: { title: "Typed field card" },
  });
  assert.equal(created.statusCode, 201);
  const card = created.json<{ id: string }>();
  const values = await db.select().from(cardCustomFieldValues).where(eq(cardCustomFieldValues.cardId, card.id));
  const byField = new Map(values.map((value) => [value.fieldId, value]));
  assert.equal(byField.get(dateField.id)?.valueDate, currentUtcDate());
  assert.equal(byField.get(checkboxField.id)?.valueCheckbox, false);
  assert.deepEqual(byField.get(selectField.id)?.valueOptionIds, [doneOption.id]);
  assert.deepEqual(byField.get(userField.id)?.valueUserIds, [f.user.id]);
});

void test("set custom field automation validates select/user cardinality and membership", async () => {
  const f = await setupWorkspace("owner-automation-set-field-cardinality@example.com");
  const missingId = "00000000-0000-0000-0000-000000000999";
  const [selectField, userField] = await db
    .insert(customFields)
    .values([
      { workspaceId: f.workspace.id, name: "Status", icon: "selector", type: "select", position: "1000.0000000000" },
      { workspaceId: f.workspace.id, name: "Reviewer", icon: "user", type: "user", position: "2000.0000000000" },
    ])
    .returning();
  assert.ok(selectField);
  assert.ok(userField);
  const optionRows = await db
    .insert(customFieldOptions)
    .values([
      { fieldId: selectField.id, label: "Todo", position: "1000.0000000000" },
      { fieldId: selectField.id, label: "Done", position: "2000.0000000000" },
    ])
    .returning();

  for (const action of [
    { type: "populate_custom_field", config: { fieldId: selectField.id, onlyIfEmpty: true, value: { kind: "select", optionIds: optionRows.map((option) => option.id) } } },
    { type: "populate_custom_field", config: { fieldId: selectField.id, onlyIfEmpty: true, value: { kind: "select", optionIds: [missingId] } } },
    { type: "populate_custom_field", config: { fieldId: userField.id, onlyIfEmpty: true, value: { kind: "user", userIds: [f.user.id, missingId] } } },
  ]) {
    const res = await f.app.inject({
      method: "POST",
      url: `/workspaces/${f.workspace.id}/automations`,
      headers: f.auth,
      payload: {
        triggerType: "card_enters_list",
        triggerListId: f.list.id,
        actions: [action],
      },
    });
    assert.equal(res.statusCode, 400);
  }
});

void test("set custom field automation can overwrite existing values", async () => {
  const f = await setupWorkspace("owner-automation-set-field-overwrite@example.com");
  const [field] = await db
    .insert(customFields)
    .values({ workspaceId: f.workspace.id, name: "Billing Status", icon: "forms", type: "text", position: "1000.0000000000" })
    .returning();
  assert.ok(field);

  const automation = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      enabled: true,
      triggerType: "card_enters_list",
      triggerListId: f.list.id,
      applyOnCreate: false,
      applyOnMove: true,
      actions: [{ type: "populate_custom_field", config: { fieldId: field.id, onlyIfEmpty: false, value: { kind: "text", text: "Automation" } } }],
    },
  });
  assert.equal(automation.statusCode, 201);

  const [otherList] = await db.select().from(lists).where(and(eq(lists.workspaceId, f.workspace.id), ne(lists.id, f.list.id))).limit(1);
  assert.ok(otherList);
  const [card] = await db
    .insert(cards)
    .values({ boardId: f.board.id, listId: otherList.id, title: "Overwrite me", position: "1000.0000000000", createdById: f.user.id })
    .returning();
  assert.ok(card);
  await db.insert(cardCustomFieldValues).values({ cardId: card.id, fieldId: field.id, valueText: "Manual" });

  const moved = await f.app.inject({
    method: "POST",
    url: `/cards/${card.id}/move`,
    headers: f.auth,
    payload: { listId: f.list.id, afterCardId: null },
  });
  assert.equal(moved.statusCode, 200);

  const [value] = await db
    .select()
    .from(cardCustomFieldValues)
    .where(and(eq(cardCustomFieldValues.cardId, card.id), eq(cardCustomFieldValues.fieldId, field.id)))
    .limit(1);
  assert.equal(value?.valueText, "Automation");
});

void test("set custom field automation effect payload includes the typed value columns", async () => {
  const f = await setupWorkspace("owner-automation-set-field-effect-payload@example.com");
  const [field] = await db
    .insert(customFields)
    .values({ workspaceId: f.workspace.id, name: "Billable", icon: "checkbox", type: "checkbox", position: "1000.0000000000" })
    .returning();
  assert.ok(field);
  const [card] = await db
    .insert(cards)
    .values({ boardId: f.board.id, listId: f.list.id, title: "Effect payload", position: "1000.0000000000", createdById: f.user.id })
    .returning();
  assert.ok(card);
  const [automation] = await db
    .insert(automations)
    .values({ workspaceId: f.workspace.id, enabled: true, position: "1000.0000000000", triggerType: "card_enters_list", triggerListId: f.list.id })
    .returning();
  assert.ok(automation);
  await db.insert(automationActions).values({
    automationId: automation.id,
    type: "populate_custom_field",
    position: "1000.0000000000",
    config: { fieldId: field.id, onlyIfEmpty: true, value: { kind: "checkbox", checked: true } },
  });

  const result = await runListEntryAutomations(db, {
    cardId: card.id,
    listId: f.list.id,
    boardId: f.board.id,
    workspaceId: f.workspace.id,
    clientId: f.user.clientId,
    trigger: "create",
  });
  const effect = result.effects.find((item) => item.type === "customFieldValueSet");
  assert.ok(effect);
  assert.deepEqual(effect.value, {
    valueText: null,
    valueNumber: null,
    valueCheckbox: true,
    valueDate: null,
    valueUrl: null,
    valueOptionIds: null,
    valueUserIds: null,
  });
});

void test("list-entry automation populates a number custom field", async () => {
  const f = await setupWorkspace("owner-automation-populate-number@example.com");
  const [field] = await db
    .insert(customFields)
    .values({ workspaceId: f.workspace.id, name: "Estimate", icon: "forms", type: "number", position: "1000.0000000000" })
    .returning();
  assert.ok(field);

  const automation = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      enabled: true,
      triggerType: "card_enters_list",
      triggerListId: f.list.id,
      actions: [{ type: "populate_custom_field", config: { fieldId: field.id, onlyIfEmpty: true, value: { kind: "number", number: 42 } } }],
    },
  });
  assert.equal(automation.statusCode, 201);

  const created = await f.app.inject({
    method: "POST",
    url: `/boards/${f.board.id}/lists/${f.list.id}/cards`,
    headers: f.auth,
    payload: { title: "Estimated card" },
  });
  assert.equal(created.statusCode, 201);
  const card = created.json<{ id: string }>();

  const [value] = await db
    .select()
    .from(cardCustomFieldValues)
    .where(and(eq(cardCustomFieldValues.cardId, card.id), eq(cardCustomFieldValues.fieldId, field.id)))
    .limit(1);
  assert.equal(Number(value?.valueNumber), 42);
});

void test("set custom field automation drops options archived after the action was saved", async () => {
  const f = await setupWorkspace("owner-automation-set-field-archived-option@example.com");
  const [field] = await db
    .insert(customFields)
    .values({ workspaceId: f.workspace.id, name: "Status", icon: "selector", type: "select", allowMultiple: true, position: "1000.0000000000" })
    .returning();
  assert.ok(field);
  const [keepOption, archivedOption] = await db
    .insert(customFieldOptions)
    .values([
      { fieldId: field.id, label: "Keep", position: "1000.0000000000" },
      { fieldId: field.id, label: "Gone", position: "2000.0000000000" },
    ])
    .returning();
  assert.ok(keepOption);
  assert.ok(archivedOption);

  const automation = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      enabled: true,
      triggerType: "card_enters_list",
      triggerListId: f.list.id,
      actions: [{ type: "populate_custom_field", config: { fieldId: field.id, onlyIfEmpty: true, value: { kind: "select", optionIds: [keepOption.id, archivedOption.id] } } }],
    },
  });
  assert.equal(automation.statusCode, 201);

  // Archiving the option after the automation is saved must not leave a dangling id on the card.
  await db.update(customFieldOptions).set({ archivedAt: new Date() }).where(eq(customFieldOptions.id, archivedOption.id));

  const created = await f.app.inject({
    method: "POST",
    url: `/boards/${f.board.id}/lists/${f.list.id}/cards`,
    headers: f.auth,
    payload: { title: "Filtered options card" },
  });
  assert.equal(created.statusCode, 201);
  const card = created.json<{ id: string }>();

  const [value] = await db
    .select()
    .from(cardCustomFieldValues)
    .where(and(eq(cardCustomFieldValues.cardId, card.id), eq(cardCustomFieldValues.fieldId, field.id)))
    .limit(1);
  assert.deepEqual(value?.valueOptionIds, [keepOption.id]);
});

void test("set custom field overwrite automation does not re-log an unchanged value", async () => {
  const f = await setupWorkspace("owner-automation-set-field-noop@example.com");
  const [field] = await db
    .insert(customFields)
    .values({ workspaceId: f.workspace.id, name: "Billing Status", icon: "forms", type: "text", position: "1000.0000000000" })
    .returning();
  assert.ok(field);

  const automation = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      enabled: true,
      triggerType: "card_enters_list",
      triggerListId: f.list.id,
      applyOnCreate: false,
      applyOnMove: true,
      actions: [{ type: "populate_custom_field", config: { fieldId: field.id, onlyIfEmpty: false, value: { kind: "text", text: "Automation" } } }],
    },
  });
  assert.equal(automation.statusCode, 201);

  const [otherList] = await db.select().from(lists).where(and(eq(lists.workspaceId, f.workspace.id), ne(lists.id, f.list.id))).limit(1);
  assert.ok(otherList);
  const [card] = await db
    .insert(cards)
    .values({ boardId: f.board.id, listId: otherList.id, title: "Already set", position: "1000.0000000000", createdById: f.user.id })
    .returning();
  assert.ok(card);
  // The card already holds the exact value the overwrite automation would write.
  await db.insert(cardCustomFieldValues).values({ cardId: card.id, fieldId: field.id, valueText: "Automation" });

  const moved = await f.app.inject({
    method: "POST",
    url: `/cards/${card.id}/move`,
    headers: f.auth,
    payload: { listId: f.list.id, afterCardId: null },
  });
  assert.equal(moved.statusCode, 200);

  const activity = await db
    .select({ id: activityEvents.id })
    .from(activityEvents)
    .where(and(eq(activityEvents.entityId, card.id), eq(activityEvents.action, ACTIVITY_ACTION.CUSTOM_FIELD_VALUE_SET)));
  assert.equal(activity.length, 0);
});

void test("set custom field automation drops users removed from the workspace after the action was saved", async () => {
  const f = await setupWorkspace("owner-automation-set-field-removed-user@example.com");
  const second = await addWorkspaceMember(f, "second-set-field-user@example.com", "Second");
  const [field] = await db
    .insert(customFields)
    .values({ workspaceId: f.workspace.id, name: "Reviewers", icon: "user", type: "user", allowMultiple: true, position: "1000.0000000000" })
    .returning();
  assert.ok(field);

  const automation = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      enabled: true,
      triggerType: "card_enters_list",
      triggerListId: f.list.id,
      actions: [{ type: "populate_custom_field", config: { fieldId: field.id, onlyIfEmpty: true, value: { kind: "user", userIds: [f.user.id, second.user.id] } } }],
    },
  });
  assert.equal(automation.statusCode, 201);

  // Removing a member after the automation is saved must not leave a non-member id on the card.
  await db.delete(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, f.workspace.id), eq(workspaceMembers.userId, second.user.id)));

  const created = await f.app.inject({
    method: "POST",
    url: `/boards/${f.board.id}/lists/${f.list.id}/cards`,
    headers: f.auth,
    payload: { title: "Reviewer card" },
  });
  assert.equal(created.statusCode, 201);
  const card = created.json<{ id: string }>();

  const [value] = await db
    .select()
    .from(cardCustomFieldValues)
    .where(and(eq(cardCustomFieldValues.cardId, card.id), eq(cardCustomFieldValues.fieldId, field.id)))
    .limit(1);
  assert.deepEqual(value?.valueUserIds, [f.user.id]);
});

void test("set custom field automation skips when every configured option was archived", async () => {
  const f = await setupWorkspace("owner-automation-set-field-all-options-gone@example.com");
  const [field] = await db
    .insert(customFields)
    .values({ workspaceId: f.workspace.id, name: "Status", icon: "selector", type: "select", position: "1000.0000000000" })
    .returning();
  assert.ok(field);
  const [option] = await db
    .insert(customFieldOptions)
    .values({ fieldId: field.id, label: "Only", position: "1000.0000000000" })
    .returning();
  assert.ok(option);

  const automation = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      enabled: true,
      triggerType: "card_enters_list",
      triggerListId: f.list.id,
      actions: [{ type: "populate_custom_field", config: { fieldId: field.id, onlyIfEmpty: true, value: { kind: "select", optionIds: [option.id] } } }],
    },
  });
  assert.equal(automation.statusCode, 201);

  await db.update(customFieldOptions).set({ archivedAt: new Date() }).where(eq(customFieldOptions.id, option.id));

  const created = await f.app.inject({
    method: "POST",
    url: `/boards/${f.board.id}/lists/${f.list.id}/cards`,
    headers: f.auth,
    payload: { title: "No live options card" },
  });
  assert.equal(created.statusCode, 201);
  const card = created.json<{ id: string }>();

  const values = await db
    .select()
    .from(cardCustomFieldValues)
    .where(and(eq(cardCustomFieldValues.cardId, card.id), eq(cardCustomFieldValues.fieldId, field.id)));
  assert.equal(values.length, 0);
});

void test("set custom field automation no-ops after the target field is deleted", async () => {
  const f = await setupWorkspace("owner-automation-set-field-deleted@example.com");
  const [field] = await db
    .insert(customFields)
    .values({ workspaceId: f.workspace.id, name: "Billing Status", icon: "forms", type: "text", position: "1000.0000000000" })
    .returning();
  assert.ok(field);

  const automation = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      enabled: true,
      triggerType: "card_enters_list",
      triggerListId: f.list.id,
      actions: [{ type: "populate_custom_field", config: { fieldId: field.id, onlyIfEmpty: true, value: { kind: "text", text: "Ready" } } }],
    },
  });
  assert.equal(automation.statusCode, 201);

  // Custom fields are hard-deleted (DELETE /custom-fields/:id) and the jsonb action config
  // is not cleaned up, so the action must silently no-op rather than fail the trigger.
  const deleted = await f.app.inject({ method: "DELETE", url: `/custom-fields/${field.id}`, headers: f.auth });
  assert.equal(deleted.statusCode, 204);

  const created = await f.app.inject({
    method: "POST",
    url: `/boards/${f.board.id}/lists/${f.list.id}/cards`,
    headers: f.auth,
    payload: { title: "Card after field delete" },
  });
  assert.equal(created.statusCode, 201);
  const card = created.json<{ id: string }>();

  const values = await db
    .select()
    .from(cardCustomFieldValues)
    .where(eq(cardCustomFieldValues.cardId, card.id));
  assert.equal(values.length, 0);
});

void test("list-entry automation applies selected checklist templates once", async () => {
  const f = await setupWorkspace("owner-automation-apply-checklists@example.com");
  const templateA = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/checklist-templates`,
    headers: f.auth,
    payload: { title: "Definition of Done", items: ["Test", "Ship"] },
  });
  assert.equal(templateA.statusCode, 201);
  const templateB = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/checklist-templates`,
    headers: f.auth,
    payload: { title: "Release", items: ["Notes"] },
  });
  assert.equal(templateB.statusCode, 201);

  const automation = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      enabled: true,
      triggerType: "card_enters_list",
      triggerListId: f.list.id,
      applyOnCreate: true,
      applyOnMove: true,
      actions: [{
        type: "apply_checklists",
        config: { templateIds: [templateA.json<{ id: string }>().id, templateB.json<{ id: string }>().id] },
      }],
    },
  });
  assert.equal(automation.statusCode, 201);

  const created = await f.app.inject({
    method: "POST",
    url: `/boards/${f.board.id}/lists/${f.list.id}/cards`,
    headers: f.auth,
    payload: { title: "Card" },
  });
  assert.equal(created.statusCode, 201);
  const card = created.json<{ id: string }>();
  let checklists = await db.select().from(cardChecklists).where(eq(cardChecklists.cardId, card.id)).orderBy(asc(cardChecklists.position));
  assert.deepEqual(checklists.map((checklist) => checklist.title), ["Definition of Done", "Release"]);
  let ledger = await db.select().from(cardChecklistTemplateApplications).where(eq(cardChecklistTemplateApplications.cardId, card.id));
  assert.equal(ledger.length, 2);

  const [otherList] = await db.select().from(lists).where(and(eq(lists.workspaceId, f.workspace.id), ne(lists.id, f.list.id))).limit(1);
  assert.ok(otherList);
  const moveAway = await f.app.inject({
    method: "POST",
    url: `/cards/${card.id}/move`,
    headers: f.auth,
    payload: { listId: otherList.id, afterCardId: null },
  });
  assert.equal(moveAway.statusCode, 200);
  const moveBack = await f.app.inject({
    method: "POST",
    url: `/cards/${card.id}/move`,
    headers: f.auth,
    payload: { listId: f.list.id, afterCardId: null },
  });
  assert.equal(moveBack.statusCode, 200);
  checklists = await db.select().from(cardChecklists).where(eq(cardChecklists.cardId, card.id));
  assert.equal(checklists.length, 2);
  ledger = await db.select().from(cardChecklistTemplateApplications).where(eq(cardChecklistTemplateApplications.cardId, card.id));
  assert.equal(ledger.length, 2);

  const activity = await db
    .select()
    .from(activityEvents)
    .where(and(eq(activityEvents.entityId, card.id), eq(activityEvents.action, "checklist:created")));
  assert.equal(activity.length, 2);
  assert.equal(activity.every((event) => Boolean((event.payload as { automationActionId?: string }).automationActionId)), true);
});

void test("automation routes reject invalid card-assigned trigger users", async () => {
  const f = await setupWorkspace("owner-automation-assignee-trigger-validation@example.com");
  const member = await addWorkspaceMember(f, "member-automation-assignee-trigger-validation@example.com", "Member");
  // A user who belongs to the org but is not a workspace member is not an assignable trigger
  // target, so referencing them must be rejected (the old "workspace observer" tier is gone).
  const [nonMember] = await db
    .insert(users)
    .values({ clientId: f.user.clientId, email: "observer-automation-assignee-trigger-validation@example.com", passwordHash: "x", displayName: "Observer" })
    .returning();
  assert.ok(nonMember);

  const missingUsers = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      triggerType: "card_assigned_to_user",
      actions: [],
    },
  });
  assert.equal(missingUsers.statusCode, 400);

  const observerUser = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      triggerType: "card_assigned_to_user",
      triggerUserIds: [nonMember.id],
      actions: [],
    },
  });
  assert.equal(observerUser.statusCode, 400);

  const automation = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      enabled: false,
      triggerType: "card_assigned_to_user",
      triggerUserIds: [member.user.id],
      actions: [],
    },
  });
  assert.equal(automation.statusCode, 201);

  const clearedUsers = await f.app.inject({
    method: "PATCH",
    url: `/automations/${automation.json<{ id: string }>().id}`,
    headers: f.auth,
    payload: { triggerUserIds: null },
  });
  assert.equal(clearedUsers.statusCode, 400);
});

void test("card-assigned automation fires once when any configured user is newly assigned", async () => {
  const f = await setupWorkspace("owner-automation-card-assigned@example.com");
  const member = await addWorkspaceMember(f, "member-automation-card-assigned@example.com", "Member");
  const other = await addWorkspaceMember(f, "other-automation-card-assigned@example.com", "Other");
  const unmatched = await addWorkspaceMember(f, "unmatched-automation-card-assigned@example.com", "Unmatched");

  const automation = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      enabled: true,
      triggerType: "card_assigned_to_user",
      triggerUserIds: [member.user.id, other.user.id],
      actions: [{ type: "set_completion", config: { completed: true } }],
    },
  });
  assert.equal(automation.statusCode, 201);

  const [card] = await db
    .insert(cards)
    .values({ boardId: f.board.id, listId: f.list.id, title: "Assign me", position: "1000.0000000000", createdById: f.user.id })
    .returning();
  assert.ok(card);

  const assignUnmatched = await f.app.inject({
    method: "PUT",
    url: `/cards/${card.id}/assignees`,
    headers: f.auth,
    payload: { userIds: [unmatched.user.id] },
  });
  assert.equal(assignUnmatched.statusCode, 200);
  const [afterUnmatched] = await db.select({ completedAt: cards.completedAt }).from(cards).where(eq(cards.id, card.id)).limit(1);
  assert.equal(afterUnmatched?.completedAt, null);

  const assignMember = await f.app.inject({
    method: "PUT",
    url: `/cards/${card.id}/assignees`,
    headers: f.auth,
    payload: { userIds: [unmatched.user.id, member.user.id] },
  });
  assert.equal(assignMember.statusCode, 200);
  const [afterMember] = await db.select({ completedAt: cards.completedAt }).from(cards).where(eq(cards.id, card.id)).limit(1);
  assert.ok(afterMember?.completedAt);

  const replaySameSet = await f.app.inject({
    method: "PUT",
    url: `/cards/${card.id}/assignees`,
    headers: f.auth,
    payload: { userIds: [unmatched.user.id, member.user.id] },
  });
  assert.equal(replaySameSet.statusCode, 200);

  const completionActivities = await db
    .select({ id: activityEvents.id })
    .from(activityEvents)
    .where(and(eq(activityEvents.entityId, card.id), eq(activityEvents.action, ACTIVITY_ACTION.COMPLETED)));
  assert.equal(completionActivities.length, 1);
});

void test("card-marked-complete automation fires for single-card completion only once", async () => {
  const f = await setupWorkspace("owner-automation-card-marked-complete-single@example.com");
  const [label] = await db
    .insert(cardLabels)
    .values({ workspaceId: f.workspace.id, name: "Done", position: "1000.0000000000" })
    .returning();
  assert.ok(label);

  const automation = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      enabled: true,
      triggerType: "card_marked_complete",
      actions: [{ type: "add_labels", config: { labelIds: [label.id] } }],
    },
  });
  assert.equal(automation.statusCode, 201);

  const [card] = await db
    .insert(cards)
    .values({ boardId: f.board.id, listId: f.list.id, title: "Complete me", position: "1000.0000000000", createdById: f.user.id })
    .returning();
  assert.ok(card);

  const completed = await f.app.inject({
    method: "PATCH",
    url: `/cards/${card.id}/completion`,
    headers: f.auth,
    payload: { completed: true },
  });
  assert.equal(completed.statusCode, 200);

  const replayComplete = await f.app.inject({
    method: "PATCH",
    url: `/cards/${card.id}/completion`,
    headers: f.auth,
    payload: { completed: true },
  });
  assert.equal(replayComplete.statusCode, 200);

  const markedIncomplete = await f.app.inject({
    method: "PATCH",
    url: `/cards/${card.id}/completion`,
    headers: f.auth,
    payload: { completed: false },
  });
  assert.equal(markedIncomplete.statusCode, 200);

  const labelAssignments = await db.select().from(cardLabelAssignments).where(eq(cardLabelAssignments.cardId, card.id));
  assert.equal(labelAssignments.length, 1);
  const labelActivities = await db
    .select()
    .from(activityEvents)
    .where(and(eq(activityEvents.entityId, card.id), eq(activityEvents.action, ACTIVITY_ACTION.LABELS_SET)));
  assert.equal(labelActivities.length, 1);
});

void test("card-marked-complete automation fires for bulk and whole-list completion", async () => {
  const f = await setupWorkspace("owner-automation-card-marked-complete-bulk-list@example.com");
  const [label] = await db
    .insert(cardLabels)
    .values({ workspaceId: f.workspace.id, name: "Completed", position: "1000.0000000000" })
    .returning();
  assert.ok(label);

  const automation = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      enabled: true,
      triggerType: "card_marked_complete",
      actions: [{ type: "add_labels", config: { labelIds: [label.id] } }],
    },
  });
  assert.equal(automation.statusCode, 201);

  const [bulkCard, listCard, alreadyComplete] = await db
    .insert(cards)
    .values([
      { boardId: f.board.id, listId: f.list.id, title: "Bulk", position: "1000.0000000000", createdById: f.user.id },
      { boardId: f.board.id, listId: f.list.id, title: "List", position: "2000.0000000000", createdById: f.user.id },
      { boardId: f.board.id, listId: f.list.id, title: "Already", position: "3000.0000000000", createdById: f.user.id, completedAt: new Date() },
    ])
    .returning();
  assert.ok(bulkCard);
  assert.ok(listCard);
  assert.ok(alreadyComplete);

  const bulkComplete = await f.app.inject({
    method: "PATCH",
    url: `/boards/${f.board.id}/cards/bulk/completion`,
    headers: f.auth,
    payload: { cardIds: [bulkCard.id, alreadyComplete.id], completed: true },
  });
  assert.equal(bulkComplete.statusCode, 200);

  const listComplete = await f.app.inject({
    method: "POST",
    url: `/boards/${f.board.id}/lists/${f.list.id}/cards/completion`,
    headers: f.auth,
    payload: { completed: true },
  });
  assert.equal(listComplete.statusCode, 200);

  const labelAssignments = await db
    .select({ cardId: cardLabelAssignments.cardId })
    .from(cardLabelAssignments)
    .where(eq(cardLabelAssignments.labelId, label.id));
  assert.deepEqual(labelAssignments.map((row) => row.cardId).sort(), [bulkCard.id, listCard.id].sort());
});

void test("automation-caused completion does not recursively fire card-marked-complete automations", async () => {
  const f = await setupWorkspace("owner-automation-card-marked-complete-nonrecursive@example.com");
  const [label] = await db
    .insert(cardLabels)
    .values({ workspaceId: f.workspace.id, name: "Should not appear", position: "1000.0000000000" })
    .returning();
  assert.ok(label);

  const completeOnEntry = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      enabled: true,
      triggerType: "card_enters_list",
      triggerListId: f.list.id,
      applyOnCreate: true,
      applyOnMove: false,
      actions: [{ type: "set_completion", config: { completed: true } }],
    },
  });
  assert.equal(completeOnEntry.statusCode, 201);

  const labelOnCompletion = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      enabled: true,
      triggerType: "card_marked_complete",
      actions: [{ type: "add_labels", config: { labelIds: [label.id] } }],
    },
  });
  assert.equal(labelOnCompletion.statusCode, 201);

  const created = await f.app.inject({
    method: "POST",
    url: `/boards/${f.board.id}/lists/${f.list.id}/cards`,
    headers: f.auth,
    payload: { title: "Completed by automation" },
  });
  assert.equal(created.statusCode, 201);
  const card = created.json<{ id: string; completedAt: string | null }>();
  assert.ok(card.completedAt);

  const labelAssignments = await db.select().from(cardLabelAssignments).where(eq(cardLabelAssignments.cardId, card.id));
  assert.equal(labelAssignments.length, 0);
});

void test("all-checklist-items-complete automation runs after the final item is completed", async () => {
  const f = await setupWorkspace("owner-automation-checklist-complete@example.com");

  const automation = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      enabled: true,
      triggerType: "all_checklist_items_complete",
      actions: [{ type: "set_completion", config: { completed: true } }],
    },
  });
  assert.equal(automation.statusCode, 201);

  const [card] = await db
    .insert(cards)
    .values({ boardId: f.board.id, listId: f.list.id, title: "Launch", position: "1000.0000000000", createdById: f.user.id })
    .returning();
  assert.ok(card);
  const [checklist] = await db
    .insert(cardChecklists)
    .values({ cardId: card.id, title: "Prep", position: "1000.0000000000" })
    .returning();
  assert.ok(checklist);
  const [firstItem, secondItem] = await db
    .insert(cardChecklistItems)
    .values([
      { checklistId: checklist.id, text: "One", position: "1000.0000000000" },
      { checklistId: checklist.id, text: "Two", position: "2000.0000000000" },
    ])
    .returning();
  assert.ok(firstItem);
  assert.ok(secondItem);

  const firstComplete = await f.app.inject({
    method: "PATCH",
    url: `/cards/${card.id}/checklists/${checklist.id}/items/${firstItem.id}`,
    headers: f.auth,
    payload: { completed: true },
  });
  assert.equal(firstComplete.statusCode, 200);
  const [afterFirst] = await db.select({ completedAt: cards.completedAt }).from(cards).where(eq(cards.id, card.id)).limit(1);
  assert.equal(afterFirst?.completedAt, null);

  const secondComplete = await f.app.inject({
    method: "PATCH",
    url: `/cards/${card.id}/checklists/${checklist.id}/items/${secondItem.id}`,
    headers: f.auth,
    payload: { completed: true },
  });
  assert.equal(secondComplete.statusCode, 200);
  const [afterSecond] = await db.select({ completedAt: cards.completedAt }).from(cards).where(eq(cards.id, card.id)).limit(1);
  assert.ok(afterSecond?.completedAt);
});

void test("card creation response includes final state after list-entry automation", async () => {
  const f = await setupWorkspace("owner-automation-final-create@example.com");

  const automation = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      enabled: true,
      triggerType: "card_enters_list",
      triggerListId: f.list.id,
      applyOnCreate: true,
      applyOnMove: false,
      actions: [{ type: "set_completion", config: { completed: true } }],
    },
  });
  assert.equal(automation.statusCode, 201);

  const created = await f.app.inject({
    method: "POST",
    url: `/boards/${f.board.id}/lists/${f.list.id}/cards`,
    headers: f.auth,
    payload: { title: "Automated card" },
  });
  assert.equal(created.statusCode, 201);
  assert.ok(created.json<{ completedAt: string | null }>().completedAt);
});

void test("label automation activity records changed label names", async () => {
  const f = await setupWorkspace("owner-automation-label-activity@example.com");
  const [label] = await db
    .insert(cardLabels)
    .values({ workspaceId: f.workspace.id, name: "Urgent", position: "1000.0000000000" })
    .returning();
  assert.ok(label);

  const automation = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      enabled: true,
      triggerType: "card_enters_list",
      triggerListId: f.list.id,
      applyOnCreate: true,
      applyOnMove: false,
      actions: [{ type: "add_labels", config: { labelIds: [label.id] } }],
    },
  });
  assert.equal(automation.statusCode, 201);

  const created = await f.app.inject({
    method: "POST",
    url: `/boards/${f.board.id}/lists/${f.list.id}/cards`,
    headers: f.auth,
    payload: { title: "Labelled by automation" },
  });
  assert.equal(created.statusCode, 201);
  const card = created.json<{ id: string }>();
  const [activity] = await db
    .select()
    .from(activityEvents)
    .where(and(eq(activityEvents.entityId, card.id), eq(activityEvents.action, "labels:set")))
    .limit(1);
  assert.ok(activity);
  assert.deepEqual(activity.payload, {
    labelIds: [label.id],
    labelNames: ["Urgent"],
    addedLabelNames: ["Urgent"],
    removedLabelNames: [],
    automationActionId: automation.json<{ actions: { id: string }[] }>().actions[0]!.id,
  });
});

void test("label-set automation fires only when the target label is newly added", async () => {
  const f = await setupWorkspace("owner-automation-label-set-single@example.com");
  const [triggerLabel, actionLabel] = await db
    .insert(cardLabels)
    .values([
      { workspaceId: f.workspace.id, name: "Urgent", position: "1000.0000000000" },
      { workspaceId: f.workspace.id, name: "Escalated", position: "2000.0000000000" },
    ])
    .returning();
  assert.ok(triggerLabel);
  assert.ok(actionLabel);

  const automation = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      enabled: true,
      triggerType: "card_label_set",
      triggerLabelId: triggerLabel.id,
      actions: [{ type: "add_labels", config: { labelIds: [actionLabel.id] } }],
    },
  });
  assert.equal(automation.statusCode, 201);

  const [card] = await db
    .insert(cards)
    .values({ boardId: f.board.id, listId: f.list.id, title: "Needs triage", position: "1000.0000000000", createdById: f.user.id })
    .returning();
  assert.ok(card);

  const firstSet = await f.app.inject({
    method: "PUT",
    url: `/cards/${card.id}/labels`,
    headers: f.auth,
    payload: { labelIds: [triggerLabel.id] },
  });
  assert.equal(firstSet.statusCode, 200);
  assert.deepEqual(firstSet.json<{ labelIds: string[] }>().labelIds.sort(), [triggerLabel.id, actionLabel.id].sort());

  const replaySet = await f.app.inject({
    method: "PUT",
    url: `/cards/${card.id}/labels`,
    headers: f.auth,
    payload: { labelIds: [triggerLabel.id, actionLabel.id] },
  });
  assert.equal(replaySet.statusCode, 200);

  const removeTrigger = await f.app.inject({
    method: "PUT",
    url: `/cards/${card.id}/labels`,
    headers: f.auth,
    payload: { labelIds: [actionLabel.id] },
  });
  assert.equal(removeTrigger.statusCode, 200);

  const labelActivities = await db
    .select()
    .from(activityEvents)
    .where(and(eq(activityEvents.entityId, card.id), eq(activityEvents.action, ACTIVITY_ACTION.LABELS_SET)));
  const automationActivities = labelActivities.filter((activity) => (activity.payload as { automationActionId?: string }).automationActionId);
  assert.equal(automationActivities.length, 1);
});

void test("label-set automation fires for bulk-added target labels", async () => {
  const f = await setupWorkspace("owner-automation-label-set-bulk@example.com");
  const [triggerLabel, actionLabel] = await db
    .insert(cardLabels)
    .values([
      { workspaceId: f.workspace.id, name: "Urgent", position: "1000.0000000000" },
      { workspaceId: f.workspace.id, name: "Escalated", position: "2000.0000000000" },
    ])
    .returning();
  assert.ok(triggerLabel);
  assert.ok(actionLabel);

  const automation = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      enabled: true,
      triggerType: "card_label_set",
      triggerLabelId: triggerLabel.id,
      actions: [{ type: "add_labels", config: { labelIds: [actionLabel.id] } }],
    },
  });
  assert.equal(automation.statusCode, 201);

  const [newlyLabeled, alreadyLabeled] = await db
    .insert(cards)
    .values([
      { boardId: f.board.id, listId: f.list.id, title: "New", position: "1000.0000000000", createdById: f.user.id },
      { boardId: f.board.id, listId: f.list.id, title: "Existing", position: "2000.0000000000", createdById: f.user.id },
    ])
    .returning();
  assert.ok(newlyLabeled);
  assert.ok(alreadyLabeled);
  await db.insert(cardLabelAssignments).values({ cardId: alreadyLabeled.id, labelId: triggerLabel.id });

  const bulk = await f.app.inject({
    method: "PATCH",
    url: `/boards/${f.board.id}/cards/bulk/labels`,
    headers: f.auth,
    payload: { cardIds: [newlyLabeled.id, alreadyLabeled.id], mode: "add", labelIds: [triggerLabel.id] },
  });
  assert.equal(bulk.statusCode, 200);
  assert.equal(bulk.json<{ updated: number }>().updated, 1);

  const actionAssignments = await db
    .select({ cardId: cardLabelAssignments.cardId })
    .from(cardLabelAssignments)
    .where(eq(cardLabelAssignments.labelId, actionLabel.id));
  assert.deepEqual(actionAssignments.map((row) => row.cardId), [newlyLabeled.id]);
});

void test("label-set automations survive deleted trigger labels and stay inert", async () => {
  const f = await setupWorkspace("owner-automation-label-set-deleted@example.com");
  const [triggerLabel, otherLabel, actionLabel] = await db
    .insert(cardLabels)
    .values([
      { workspaceId: f.workspace.id, name: "Urgent", position: "1000.0000000000" },
      { workspaceId: f.workspace.id, name: "Other", position: "2000.0000000000" },
      { workspaceId: f.workspace.id, name: "Escalated", position: "3000.0000000000" },
    ])
    .returning();
  assert.ok(triggerLabel);
  assert.ok(otherLabel);
  assert.ok(actionLabel);

  const automation = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      enabled: true,
      triggerType: "card_label_set",
      triggerLabelId: triggerLabel.id,
      actions: [{ type: "add_labels", config: { labelIds: [actionLabel.id] } }],
    },
  });
  assert.equal(automation.statusCode, 201);
  await db.delete(cardLabels).where(eq(cardLabels.id, triggerLabel.id));

  const loaded = await f.app.inject({
    method: "GET",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
  });
  assert.equal(loaded.statusCode, 200);
  assert.equal(loaded.json<{ triggerLabelId: string }[]>()[0]?.triggerLabelId, triggerLabel.id);

  const [card] = await db
    .insert(cards)
    .values({ boardId: f.board.id, listId: f.list.id, title: "Not urgent", position: "1000.0000000000", createdById: f.user.id })
    .returning();
  assert.ok(card);
  const setOther = await f.app.inject({
    method: "PUT",
    url: `/cards/${card.id}/labels`,
    headers: f.auth,
    payload: { labelIds: [otherLabel.id] },
  });
  assert.equal(setOther.statusCode, 200);

  const actionAssignments = await db
    .select()
    .from(cardLabelAssignments)
    .where(and(eq(cardLabelAssignments.cardId, card.id), eq(cardLabelAssignments.labelId, actionLabel.id)));
  assert.equal(actionAssignments.length, 0);
});

void test("automation-added labels do not trigger label-set automations", async () => {
  const f = await setupWorkspace("owner-automation-label-set-noncascade@example.com");
  const [initialLabel, intermediateLabel, finalLabel] = await db
    .insert(cardLabels)
    .values([
      { workspaceId: f.workspace.id, name: "Initial", position: "1000.0000000000" },
      { workspaceId: f.workspace.id, name: "Intermediate", position: "2000.0000000000" },
      { workspaceId: f.workspace.id, name: "Final", position: "3000.0000000000" },
    ])
    .returning();
  assert.ok(initialLabel);
  assert.ok(intermediateLabel);
  assert.ok(finalLabel);

  const firstAutomation = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      enabled: true,
      triggerType: "card_label_set",
      triggerLabelId: initialLabel.id,
      actions: [{ type: "add_labels", config: { labelIds: [intermediateLabel.id] } }],
    },
  });
  assert.equal(firstAutomation.statusCode, 201);
  const cascadingAutomation = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      enabled: true,
      triggerType: "card_label_set",
      triggerLabelId: intermediateLabel.id,
      actions: [{ type: "add_labels", config: { labelIds: [finalLabel.id] } }],
    },
  });
  assert.equal(cascadingAutomation.statusCode, 201);

  const [card] = await db
    .insert(cards)
    .values({ boardId: f.board.id, listId: f.list.id, title: "No cascade", position: "1000.0000000000", createdById: f.user.id })
    .returning();
  assert.ok(card);
  const setInitial = await f.app.inject({
    method: "PUT",
    url: `/cards/${card.id}/labels`,
    headers: f.auth,
    payload: { labelIds: [initialLabel.id] },
  });
  assert.equal(setInitial.statusCode, 200);

  const assignments = await db
    .select({ labelId: cardLabelAssignments.labelId })
    .from(cardLabelAssignments)
    .where(eq(cardLabelAssignments.cardId, card.id));
  const assignedIds = assignments.map((assignment) => assignment.labelId).sort();
  assert.deepEqual(assignedIds, [initialLabel.id, intermediateLabel.id].sort());
});

void test("list-entry completion automation suppresses notifications for the user who moved the card", async () => {
  const f = await setupWorkspace("owner-automation-move-self-notification@example.com");
  const member = await addWorkspaceMember(f, "member-automation-move-self-notification@example.com", "Member");
  const other = await addWorkspaceMember(f, "other-automation-move-self-notification@example.com", "Other");
  const cardWatcher = await addWorkspaceMember(f, "card-watcher-automation-move-self-notification@example.com", "Card Watcher");
  const boardWatcher = await addWorkspaceMember(f, "board-watcher-automation-move-self-notification@example.com", "Board Watcher");
  const [targetList] = await db
    .insert(lists)
    .values({ workspaceId: f.workspace.id, name: "Done", position: "2000.0000000000" })
    .returning();
  assert.ok(targetList);

  const automation = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      enabled: true,
      triggerType: "card_enters_list",
      triggerListId: targetList.id,
      applyOnCreate: false,
      applyOnMove: true,
      actions: [{ type: "set_completion", config: { completed: true } }],
    },
  });
  assert.equal(automation.statusCode, 201);

  const [card] = await db
    .insert(cards)
    .values({ boardId: f.board.id, listId: f.list.id, title: "Ship it", position: "1000.0000000000", createdById: f.user.id })
    .returning();
  assert.ok(card);
  await db.insert(cardAssignees).values([
    { cardId: card.id, userId: member.user.id },
    { cardId: card.id, userId: other.user.id },
  ]);
  await db.insert(cardWatchers).values({ cardId: card.id, userId: cardWatcher.user.id });
  await db.insert(boardWatchers).values({ boardId: f.board.id, userId: boardWatcher.user.id });

  const moved = await f.app.inject({
    method: "POST",
    url: `/cards/${card.id}/move`,
    headers: member.auth,
    payload: { listId: targetList.id, beforeCardId: null },
  });
  assert.equal(moved.statusCode, 200);
  await waitForNotificationFanoutForTests();

  const rows = await db
    .select({ userId: notifications.userId, action: activityEvents.action, reason: notifications.reason })
    .from(notifications)
    .innerJoin(activityEvents, eq(activityEvents.id, notifications.activityId))
    .where(and(eq(notifications.cardId, card.id), eq(activityEvents.action, "completed")));
  assert.deepEqual(rows, [{ userId: other.user.id, action: "completed", reason: "assigned" }]);

  const listed = await f.app.inject({ method: "GET", url: "/notifications", headers: other.auth });
  assert.equal(listed.statusCode, 200);
  const notification = listed.json<{ items: { cardId: string | null; actorName: string | null; actorAvatarUrl: string | null; activity: { actorKind: string } | null }[] }>()
    .items.find((item) => item.cardId === card.id);
  assert.ok(notification);
  assert.equal(notification.actorName, "Kanera");
  assert.equal(notification.actorAvatarUrl, null);
  assert.equal(notification.activity?.actorKind, "system");
});

void test("checklist-completion automation suppresses notifications for the user who completed the final item", async () => {
  const f = await setupWorkspace("owner-automation-checklist-self-notification@example.com");
  const member = await addWorkspaceMember(f, "member-automation-checklist-self-notification@example.com", "Member");
  const other = await addWorkspaceMember(f, "other-automation-checklist-self-notification@example.com", "Other");

  const automation = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      enabled: true,
      triggerType: "all_checklist_items_complete",
      actions: [{ type: "set_completion", config: { completed: true } }],
    },
  });
  assert.equal(automation.statusCode, 201);

  const [card] = await db
    .insert(cards)
    .values({ boardId: f.board.id, listId: f.list.id, title: "Checklist ship", position: "1000.0000000000", createdById: f.user.id })
    .returning();
  assert.ok(card);
  await db.insert(cardAssignees).values([
    { cardId: card.id, userId: member.user.id },
    { cardId: card.id, userId: other.user.id },
  ]);
  await db.insert(cardWatchers).values({ cardId: card.id, userId: member.user.id });
  const [checklist] = await db
    .insert(cardChecklists)
    .values({ cardId: card.id, title: "Prep", position: "1000.0000000000" })
    .returning();
  assert.ok(checklist);
  const [item] = await db
    .insert(cardChecklistItems)
    .values({ checklistId: checklist.id, text: "Only item", position: "1000.0000000000" })
    .returning();
  assert.ok(item);

  const completed = await f.app.inject({
    method: "PATCH",
    url: `/cards/${card.id}/checklists/${checklist.id}/items/${item.id}`,
    headers: member.auth,
    payload: { completed: true },
  });
  assert.equal(completed.statusCode, 200);
  await waitForNotificationFanoutForTests();

  const rows = await db
    .select({ userId: notifications.userId, action: activityEvents.action })
    .from(notifications)
    .innerJoin(activityEvents, eq(activityEvents.id, notifications.activityId))
    .where(and(eq(notifications.cardId, card.id), eq(activityEvents.action, "completed")));
  assert.equal(rows.some((row) => row.userId === member.user.id), false);
  assert.equal(rows.some((row) => row.userId === other.user.id), true);
});

void test("move-to-list automation notifies assignees but not watchers", async () => {
  const f = await setupWorkspace("owner-automation-move-assignee-notifications@example.com");
  const member = await addWorkspaceMember(f, "member-automation-move-assignee-notifications@example.com", "Member");
  const other = await addWorkspaceMember(f, "other-automation-move-assignee-notifications@example.com", "Other");
  const cardWatcher = await addWorkspaceMember(f, "card-watcher-automation-move-assignee-notifications@example.com", "Card Watcher");
  const boardWatcher = await addWorkspaceMember(f, "board-watcher-automation-move-assignee-notifications@example.com", "Board Watcher");
  const [triggerList] = await db
    .insert(lists)
    .values({ workspaceId: f.workspace.id, name: "Review", position: "2000.0000000000" })
    .returning();
  const [targetList] = await db
    .insert(lists)
    .values({ workspaceId: f.workspace.id, name: "Done", position: "3000.0000000000" })
    .returning();
  assert.ok(triggerList);
  assert.ok(targetList);

  const automation = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      enabled: true,
      triggerType: "card_enters_list",
      triggerListId: triggerList.id,
      applyOnCreate: false,
      applyOnMove: true,
      actions: [{ type: "move_to_list", config: { listId: targetList.id, placement: "bottom" } }],
    },
  });
  assert.equal(automation.statusCode, 201);

  const [card] = await db
    .insert(cards)
    .values({ boardId: f.board.id, listId: f.list.id, title: "Move by automation", position: "1000.0000000000", createdById: f.user.id })
    .returning();
  assert.ok(card);
  await db.insert(cardAssignees).values([
    { cardId: card.id, userId: member.user.id },
    { cardId: card.id, userId: other.user.id },
  ]);
  await db.insert(cardWatchers).values({ cardId: card.id, userId: cardWatcher.user.id });
  await db.insert(boardWatchers).values({ boardId: f.board.id, userId: boardWatcher.user.id });

  const moved = await f.app.inject({
    method: "POST",
    url: `/cards/${card.id}/move`,
    headers: member.auth,
    payload: { listId: triggerList.id, beforeCardId: null },
  });
  assert.equal(moved.statusCode, 200);
  await waitForNotificationFanoutForTests();

  const rows = await db
    .select({ userId: notifications.userId, action: activityEvents.action, reason: notifications.reason, payload: activityEvents.payload })
    .from(notifications)
    .innerJoin(activityEvents, eq(activityEvents.id, notifications.activityId))
    .where(and(eq(notifications.cardId, card.id), eq(activityEvents.action, "moved")));
  const automationRows = rows.filter((row) => Boolean((row.payload as { automationActionId?: string }).automationActionId));
  assert.equal(automationRows.length, 1);
  assert.equal(automationRows[0]?.userId, other.user.id);
  assert.equal(automationRows[0]?.action, "moved");
  assert.equal(automationRows[0]?.reason, "assigned");
});

void test("assignee automation suppresses assignment email for the triggering user only", async () => {
  const f = await setupWorkspace("owner-automation-assignment-self-email@example.com");
  const member = await addWorkspaceMember(f, "member-automation-assignment-self-email@example.com", "Member");
  const other = await addWorkspaceMember(f, "other-automation-assignment-self-email@example.com", "Other");

  const automation = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      enabled: true,
      triggerType: "card_enters_list",
      triggerListId: f.list.id,
      applyOnCreate: true,
      applyOnMove: false,
      actions: [{ type: "add_assignees", config: { userIds: [member.user.id, other.user.id] } }],
    },
  });
  assert.equal(automation.statusCode, 201);

  const created = await f.app.inject({
    method: "POST",
    url: `/boards/${f.board.id}/lists/${f.list.id}/cards`,
    headers: member.auth,
    payload: { title: "Assign by automation" },
  });
  assert.equal(created.statusCode, 201);

  const rows = await db
    .select()
    .from(emailQueue)
    .where(and(eq(emailQueue.type, "card_assigned"), inArray(emailQueue.toEmail, [member.user.email, other.user.email])));
  assert.deepEqual(rows.map((row) => row.toEmail), [other.user.email]);
});

void test("move-to-list automation can place entering cards at the top of the list", async () => {
  const f = await setupWorkspace("owner-automation-move-top@example.com");

  const existing = await f.app.inject({
    method: "POST",
    url: `/boards/${f.board.id}/lists/${f.list.id}/cards`,
    headers: f.auth,
    payload: { title: "Already here" },
  });
  assert.equal(existing.statusCode, 201);

  const automation = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      enabled: true,
      triggerType: "card_enters_list",
      triggerListId: f.list.id,
      applyOnCreate: true,
      applyOnMove: true,
      actions: [{ type: "move_to_list", config: { listId: f.list.id, placement: "top" } }],
    },
  });
  assert.equal(automation.statusCode, 201);

  const created = await f.app.inject({
    method: "POST",
    url: `/boards/${f.board.id}/lists/${f.list.id}/cards`,
    headers: f.auth,
    payload: { title: "Pinned" },
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json<{ listId: string }>().listId, f.list.id);

  const [existingCard] = await db.select().from(cards).where(eq(cards.id, existing.json<{ id: string }>().id)).limit(1);
  const [createdCard] = await db.select().from(cards).where(eq(cards.id, created.json<{ id: string }>().id)).limit(1);
  assert.ok(existingCard);
  assert.ok(createdCard);
  assert.ok(Number(createdCard.position) < Number(existingCard.position));
});

void test("move-to-list automation locks the destination list while computing its position", async () => {
  const f = await setupWorkspace("owner-automation-move-lock@example.com");
  const [triggerList, targetList] = await db
    .insert(lists)
    .values([
      { workspaceId: f.workspace.id, name: "Trigger", position: "2000.0000000000" },
      { workspaceId: f.workspace.id, name: "Target", position: "3000.0000000000" },
    ])
    .returning();
  assert.ok(triggerList);
  assert.ok(targetList);

  const automation = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      enabled: true,
      triggerType: "card_enters_list",
      triggerListId: triggerList.id,
      applyOnCreate: false,
      applyOnMove: true,
      actions: [{ type: "move_to_list", config: { listId: targetList.id, placement: "bottom" } }],
    },
  });
  assert.equal(automation.statusCode, 201);

  const [card] = await db
    .insert(cards)
    .values({ boardId: f.board.id, listId: triggerList.id, title: "Lock target", position: "1000.0000000000", createdById: f.user.id })
    .returning();
  assert.ok(card);

  let releaseTransaction!: () => void;
  const holdTransaction = new Promise<void>((resolve) => { releaseTransaction = resolve; });
  let destinationLocked!: () => void;
  let destinationLockFailed!: (error: unknown) => void;
  const lockAcquired = new Promise<void>((resolve, reject) => {
    destinationLocked = resolve;
    destinationLockFailed = reject;
  });
  const automationTransaction = db.transaction(async (tx) => {
    const result = await runListEntryAutomations(tx, {
      cardId: card.id,
      listId: triggerList.id,
      boardId: f.board.id,
      workspaceId: f.workspace.id,
      clientId: f.user.clientId,
      trigger: "move",
      triggerActorId: f.user.id,
    });
    assert.equal(result.effects.some((effect) => effect.type === "cardMoved"), true);
    destinationLocked();
    await holdTransaction;
  }).catch((error: unknown) => {
    destinationLockFailed(error);
    throw error;
  });

  const contender = await pool.connect();
  try {
    await lockAcquired;
    await contender.query("begin");
    await contender.query("set local lock_timeout = '100ms'");
    // Position writers coordinate on this row before reading the destination edge card.
    await assert.rejects(
      contender.query(`select id from "list" where id = $1 for update`, [targetList.id]),
      (error: unknown) => Error.isError(error) && /lock timeout|canceling statement due to lock timeout/.test(error.message),
    );
  } finally {
    await contender.query("rollback").catch(() => undefined);
    contender.release();
    releaseTransaction();
    await automationTransaction;
  }
});

void test("move-to-bottom automation uses the card's current list", async () => {
  const f = await setupWorkspace("owner-automation-move-bottom@example.com");

  const existing = await f.app.inject({
    method: "POST",
    url: `/boards/${f.board.id}/lists/${f.list.id}/cards`,
    headers: f.auth,
    payload: { title: "Already here" },
  });
  assert.equal(existing.statusCode, 201);

  const automation = await f.app.inject({
    method: "POST",
    url: `/workspaces/${f.workspace.id}/automations`,
    headers: f.auth,
    payload: {
      enabled: true,
      triggerType: "card_enters_list",
      triggerListId: f.list.id,
      applyOnCreate: true,
      applyOnMove: true,
      actions: [{ type: "move_to_bottom", config: {} }],
    },
  });
  assert.equal(automation.statusCode, 201);

  const created = await f.app.inject({
    method: "POST",
    url: `/boards/${f.board.id}/lists/${f.list.id}/cards`,
    headers: f.auth,
    payload: { title: "Dropped", atTop: true },
  });
  assert.equal(created.statusCode, 201);

  const [existingCard] = await db.select().from(cards).where(eq(cards.id, existing.json<{ id: string }>().id)).limit(1);
  const [createdCard] = await db.select().from(cards).where(eq(cards.id, created.json<{ id: string }>().id)).limit(1);
  assert.ok(existingCard);
  assert.ok(createdCard);
  assert.equal(createdCard.listId, f.list.id);
  assert.ok(Number(createdCard.position) > Number(existingCard.position));
});

void test("due date automation sweep runs overdue candidates while ignoring future due dates", async () => {
  const f = await setupWorkspace("owner-automation-due-sweep@example.com");

  await db.insert(automations).values({
    workspaceId: f.workspace.id,
    enabled: true,
    position: "1000.0000000000",
    triggerType: "due_date_arrives",
  });
  const [automation] = await db.select().from(automations).where(eq(automations.workspaceId, f.workspace.id)).limit(1);
  assert.ok(automation);
  await db.insert(automationActions).values({
    automationId: automation.id,
    type: "set_completion",
    config: { completed: true },
    position: "1000.0000000000",
  });

  const [overdue] = await db
    .insert(cards)
    .values({
      listId: f.list.id,
      boardId: f.board.id,
      title: "Overdue",
      position: "1000.0000000000",
      createdById: f.user.id,
      dueDateLocalDate: "2026-05-20",
      dueDateSlot: "anyTime",
      dueDateTimezone: "UTC",
    })
    .returning();
  assert.ok(overdue);
  await db.insert(cards).values({
    listId: f.list.id,
    boardId: f.board.id,
    title: "Future",
    position: "2000.0000000000",
    createdById: f.user.id,
    dueDateLocalDate: "2026-06-20",
    dueDateSlot: "anyTime",
    dueDateTimezone: "UTC",
  });

  const ran = await runDueDateAutomationSweep(undefined, new Date("2026-05-21T12:00:00.000Z"));
  assert.equal(ran, 1);

  const [updated] = await db.select().from(cards).where(eq(cards.id, overdue.id)).limit(1);
  assert.ok(updated?.completedAt);
});

void test("due date automation sweep pages through every overdue candidate across batches", async () => {
  const f = await setupWorkspace("owner-automation-due-sweep-batched@example.com");

  await db.insert(automations).values({
    workspaceId: f.workspace.id,
    enabled: true,
    position: "1000.0000000000",
    triggerType: "due_date_arrives",
  });
  const [automation] = await db.select().from(automations).where(eq(automations.workspaceId, f.workspace.id)).limit(1);
  assert.ok(automation);
  await db.insert(automationActions).values({
    automationId: automation.id,
    type: "set_completion",
    config: { completed: true },
    position: "1000.0000000000",
  });

  // Several overdue cards with distinct due dates so the keyset cursor must advance
  // across multiple batches to reach all of them.
  const overdueDates = ["2026-05-15", "2026-05-16", "2026-05-17", "2026-05-18", "2026-05-19"];
  const inserted = await db
    .insert(cards)
    .values(overdueDates.map((dueDateLocalDate, index) => ({
      listId: f.list.id,
      boardId: f.board.id,
      title: `Overdue ${index}`,
      position: `${(index + 1) * 1000}.0000000000`,
      createdById: f.user.id,
      dueDateLocalDate,
      dueDateSlot: "anyTime" as const,
      dueDateTimezone: "UTC",
    })))
    .returning();
  assert.equal(inserted.length, overdueDates.length);

  // batchSize of 1 forces one card per page, exercising the pagination loop end to end.
  const ran = await runDueDateAutomationSweep(undefined, new Date("2026-05-21T12:00:00.000Z"), 1);
  assert.equal(ran, overdueDates.length);

  const completed = await db.select({ id: cards.id, completedAt: cards.completedAt }).from(cards).where(eq(cards.listId, f.list.id));
  assert.equal(completed.length, overdueDates.length);
  assert.ok(completed.every((card) => card.completedAt));
});

void test("automation runners skip disabled automations and automations without actions", async () => {
  const f = await setupWorkspace("owner-automation-runner-invariants@example.com");

  await db.insert(automations).values([
    {
      workspaceId: f.workspace.id,
      enabled: false,
      position: "1000.0000000000",
      triggerType: "card_enters_list",
      triggerListId: f.list.id,
      applyOnCreate: true,
      applyOnMove: true,
    },
    {
      workspaceId: f.workspace.id,
      enabled: true,
      position: "2000.0000000000",
      triggerType: "card_enters_list",
      triggerListId: f.list.id,
      applyOnCreate: true,
      applyOnMove: true,
    },
  ]);
  const [disabled] = await db.select().from(automations).where(and(eq(automations.workspaceId, f.workspace.id), eq(automations.enabled, false))).limit(1);
  assert.ok(disabled);
  await db.insert(automationActions).values({
    automationId: disabled.id,
    type: "set_completion",
    config: { completed: true },
    position: "1000.0000000000",
  });

  const created = await f.app.inject({
    method: "POST",
    url: `/boards/${f.board.id}/lists/${f.list.id}/cards`,
    headers: f.auth,
    payload: { title: "Should stay open" },
  });
  assert.equal(created.statusCode, 201);
  const [card] = await db.select().from(cards).where(eq(cards.id, created.json<{ id: string }>().id)).limit(1);
  assert.equal(card?.completedAt, null);
});

void test("due date automation sweep skips enabled automations without actions", async () => {
  const f = await setupWorkspace("owner-automation-due-empty-actions@example.com");

  const [automation] = await db
    .insert(automations)
    .values({
      workspaceId: f.workspace.id,
      enabled: true,
      position: "1000.0000000000",
      triggerType: "due_date_arrives",
    })
    .returning();
  assert.ok(automation);
  const [overdue] = await db
    .insert(cards)
    .values({
      listId: f.list.id,
      boardId: f.board.id,
      title: "No-op overdue",
      position: "1000.0000000000",
      createdById: f.user.id,
      dueDateLocalDate: "2026-05-20",
      dueDateSlot: "anyTime",
      dueDateTimezone: "UTC",
    })
    .returning();
  assert.ok(overdue);

  const ran = await runDueDateAutomationSweep(undefined, new Date("2026-05-21T12:00:00.000Z"));
  assert.equal(ran, 0);
  const runs = await db.select().from(automationDueDateRuns).where(eq(automationDueDateRuns.automationId, automation.id));
  assert.equal(runs.length, 0);
});
