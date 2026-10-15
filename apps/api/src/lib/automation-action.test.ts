import assert from "node:assert/strict";
import { test } from "node:test";
import type { AutomationAction } from "@kanera/shared/schema";
import { executableAutomationAction } from "./automation-action.js";

function storedAction(type: AutomationAction["type"], config: unknown): AutomationAction {
  return {
    id: "action-1",
    automationId: "automation-1",
    type,
    config,
    position: "1000.0000000000",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  } as AutomationAction;
}

void test("persisted automation defaults retain executor semantics independently of editor drafts", () => {
  assert.deepEqual(executableAutomationAction(storedAction("set_completion", {}))?.config, { completed: false });
  assert.deepEqual(executableAutomationAction(storedAction("set_due_date", {}))?.config, { offsetDays: 0, slot: "anyTime" });
  assert.deepEqual(executableAutomationAction(storedAction("move_to_list", { listId: "list-1" }))?.config, { listId: "list-1", placement: "bottom" });
  assert.deepEqual(executableAutomationAction(storedAction("add_labels", { labelId: "label-1" }))?.config, { labelIds: [] });
  assert.deepEqual(executableAutomationAction(storedAction("add_assignees", { userId: "user-1" }))?.config, { userIds: [] });
  assert.deepEqual(executableAutomationAction(storedAction("apply_checklists", { templateId: "template-1" }))?.config, { templateIds: [] });
});

void test("persisted automation values are neither creation-validated nor overwritten by defaults", () => {
  const action = storedAction("populate_custom_field", { fieldId: "removed-field", value: { kind: "checkbox", checked: false }, onlyIfEmpty: false });
  const before = structuredClone(action);
  assert.deepEqual(executableAutomationAction(action), action);
  assert.deepEqual(action, before);
  assert.deepEqual(executableAutomationAction(storedAction("set_due_date", { offsetDays: 0, slot: "morning" }))?.config, { offsetDays: 0, slot: "morning" });
  assert.deepEqual(executableAutomationAction(storedAction("set_completion", { completed: false }))?.config, { completed: false });
  assert.deepEqual(executableAutomationAction(storedAction("move_to_list", { listId: "list-1", placement: "top" }))?.config, { listId: "list-1", placement: "top" });
});

void test("missing field values survive normalization for target lookup and outbound actions keep defensive defaults", () => {
  assert.equal(executableAutomationAction(storedAction("populate_custom_field", {})), null);
  assert.deepEqual(executableAutomationAction(storedAction("populate_custom_field", { fieldId: "not-a-uuid" }))?.config, { fieldId: "not-a-uuid", value: null, onlyIfEmpty: true });
  assert.deepEqual(executableAutomationAction(storedAction("populate_custom_field", { fieldId: "not-a-uuid", value: null }))?.config, { fieldId: "not-a-uuid", value: null, onlyIfEmpty: true });
  assert.deepEqual(executableAutomationAction(storedAction("populate_custom_field", { fieldId: "field-1", value: { kind: "number", number: 0 } }))?.config, {
    fieldId: "field-1", value: { kind: "number", number: 0 }, onlyIfEmpty: true,
  });
  assert.deepEqual(executableAutomationAction(storedAction("post_comment", { template: 123 }))?.config, { template: "" });
  assert.deepEqual(executableAutomationAction(storedAction("call_webhook", { endpointId: null }))?.config, { endpointId: "" });
});
