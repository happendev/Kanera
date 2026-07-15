import {
  createBoardBody,
  createCustomFieldBody,
  createListBody,
  createNoteBody,
  createWorkspaceBody,
  updateBoardBody,
  updateListBody,
  updateNoteBody,
} from "@kanera/shared/dto";
import assert from "node:assert/strict";
import { test } from "node:test";

void test("icon-bearing creates apply stable entity defaults", () => {
  assert.equal(createBoardBody.parse({ name: "Roadmap" }).icon, "layout-kanban");
  assert.equal(createListBody.parse({ name: "Todo", icon: null }).icon, "list");
  assert.equal(createNoteBody.parse({ scope: "team", icon: null }).icon, "file-text");
  assert.equal(createCustomFieldBody.parse({ name: "Owner", type: "user" }).icon, "forms");

  const workspace = createWorkspaceBody.parse({
    name: "Delivery",
    initialBoard: { name: "Roadmap" },
    lists: [{ name: "Todo" }, { name: "Done", icon: null }],
  });
  assert.equal(workspace.icon, "rocket");
  assert.equal(workspace.initialBoard?.icon, "layout-kanban");
  assert.deepEqual(workspace.lists?.map((list) => list.icon), ["list", "list"]);
});

void test("icon-bearing DTOs reject slugs absent from the bundled Tabler font", () => {
  for (const schema of [createBoardBody, createListBody, createNoteBody]) {
    const result = schema.safeParse({ name: "Example", scope: "team", icon: "made-up-agent-icon" });
    assert.equal(result.success, false);
  }
  assert.equal(createBoardBody.parse({ name: "Roadmap", icon: "rocket" }).icon, "rocket");
});

void test("clearing an existing icon restores its entity default", () => {
  assert.equal(updateBoardBody.parse({ icon: null }).icon, "layout-kanban");
  assert.equal(updateListBody.parse({ icon: null }).icon, "list");
  assert.equal(updateNoteBody.parse({ icon: null }).icon, "file-text");
  assert.equal(updateBoardBody.parse({ name: "Renamed" }).icon, undefined);
});
