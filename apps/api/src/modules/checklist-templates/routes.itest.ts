import "../../test/setup.integration.js";
import { automationActions, checklistTemplates, lists } from "@kanera/shared/schema";
import { asc, eq, inArray } from "drizzle-orm";
import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../../db.js";
import { buildIntegrationServer } from "../../test/integration.js";

type SignupResponse = { accessToken: string; user: { id: string } };
type WorkspaceResponse = { id: string };
type TemplateResponse = { id: string; title: string; items: { text: string }[]; position: string };

async function setup() {
  const app = await buildIntegrationServer();
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { orgName: "Acme", email: "owner@example.com", password: "Abc12345", displayName: "Owner" },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken } = signup.json<SignupResponse>();
  const auth = { authorization: `Bearer ${accessToken}` };

  const wsCreated = await app.inject({ method: "POST", url: "/workspaces", headers: auth, payload: { name: "Delivery" } });
  assert.equal(wsCreated.statusCode, 201);
  const workspace = wsCreated.json<WorkspaceResponse>();

  const workspaceLists = await db
    .select()
    .from(lists)
    .where(eq(lists.workspaceId, workspace.id))
    .orderBy(asc(lists.position));
  assert.ok(workspaceLists.length >= 2, "workspace should seed default lists");
  return { app, auth, workspace, lists: workspaceLists };
}

async function createTemplate(
  app: Awaited<ReturnType<typeof setup>>["app"],
  auth: Record<string, string>,
  workspaceId: string,
  body: { title: string; items: string[] },
) {
  const res = await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/checklist-templates`, headers: auth, payload: body });
  assert.equal(res.statusCode, 201);
  return res.json<TemplateResponse>();
}

void test("checklist templates can be created and edited with items", async () => {
  const { app, auth, workspace } = await setup();
  const template = await createTemplate(app, auth, workspace.id, {
    title: "Definition of Done",
    items: ["Write tests", "Update docs"],
  });

  assert.equal(template.title, "Definition of Done");
  assert.deepEqual(template.items.map((item) => item.text), ["Write tests", "Update docs"]);

  const updated = await app.inject({
    method: "PATCH",
    url: `/checklist-templates/${template.id}`,
    headers: auth,
    payload: { title: "Definition of Ready", items: ["Acceptance criteria"] },
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json<TemplateResponse>().title, "Definition of Ready");
  assert.deepEqual(updated.json<TemplateResponse>().items.map((item) => item.text), ["Acceptance criteria"]);
});

void test("checklist templates can be reordered and soft deleted", async () => {
  const { app, auth, workspace } = await setup();
  const first = await createTemplate(app, auth, workspace.id, { title: "First", items: [] });
  const second = await createTemplate(app, auth, workspace.id, { title: "Second", items: [] });

  const moved = await app.inject({
    method: "POST",
    url: `/checklist-templates/${second.id}/move`,
    headers: auth,
    payload: { beforeTemplateId: first.id },
  });
  assert.equal(moved.statusCode, 200);
  assert.ok(Number(moved.json<{ position: string }>().position) < Number(first.position));

  const deleted = await app.inject({ method: "DELETE", url: `/checklist-templates/${first.id}`, headers: auth });
  assert.equal(deleted.statusCode, 204);
  const [archived] = await db.select().from(checklistTemplates).where(eq(checklistTemplates.id, first.id)).limit(1);
  assert.ok(archived?.archivedAt);
});

void test("deleting a checklist template removes it from automation actions", async () => {
  const { app, auth, workspace, lists: workspaceLists } = await setup();
  const first = await createTemplate(app, auth, workspace.id, { title: "First", items: [] });
  const second = await createTemplate(app, auth, workspace.id, { title: "Second", items: [] });
  const triggerList = workspaceLists[0];
  assert.ok(triggerList);

  const mixedAutomation = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/automations`,
    headers: auth,
    payload: {
      triggerType: "card_enters_list",
      triggerListId: triggerList.id,
      actions: [{ type: "apply_checklists", config: { templateIds: [first.id, second.id] } }],
    },
  });
  assert.equal(mixedAutomation.statusCode, 201);
  const singleTemplateAutomation = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/automations`,
    headers: auth,
    payload: {
      triggerType: "card_enters_list",
      triggerListId: triggerList.id,
      actions: [{ type: "apply_checklists", config: { templateIds: [first.id] } }],
    },
  });
  assert.equal(singleTemplateAutomation.statusCode, 201);

  const deleted = await app.inject({ method: "DELETE", url: `/checklist-templates/${first.id}`, headers: auth });
  assert.equal(deleted.statusCode, 204);

  const actions = await db
    .select()
    .from(automationActions)
    .where(inArray(automationActions.automationId, [
      mixedAutomation.json<{ id: string }>().id,
      singleTemplateAutomation.json<{ id: string }>().id,
    ]))
    .orderBy(asc(automationActions.position));
  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.automationId, mixedAutomation.json<{ id: string }>().id);
  assert.deepEqual(actions[0]?.config, { templateIds: [second.id] });
});
