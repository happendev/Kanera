import "../../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type Stripe from "stripe";
import { activityEvents, automationActions, automations, boardInvitationGrants, boardInvitations, boardMembers, boardWatchers, boards, cardAssignees, cardChecklistItems, cardChecklists, cardLabelAssignments, cardLabels, cardMentions, cardWatchers, cards, clientGuestSeats, clients, customFields, directRealtimeOutbox, emailQueue, eventOutbox, lists, notifications, users, workspaceAnalyticsMilestones, workspaceMembers, workspaces } from "@kanera/shared/schema";
import { and, eq, inArray } from "drizzle-orm";
import { DEFAULT_WORKSPACE_CUSTOM_FIELDS } from "@kanera/shared/default-workspace-custom-fields";
import { DEFAULT_WORKSPACE_LABELS } from "@kanera/shared/default-workspace-labels";
import { DEFAULT_WORKSPACE_LIST_NAMES } from "@kanera/shared/default-workspace-lists";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { setStripeClientForTests } from "../../lib/billing.js";
import { buildPublicApiServer } from "../../public-api-server.js";
import { buildIntegrationServer, testUploadsDir } from "../../test/integration.js";

const position = (index: number) => `${(index + 1) * 1000}.0000000000`;
type SignupResponse = { accessToken: string; user: { id: string; clientId: string; hasWorkspace: boolean } };
type WorkspaceResponse = { id: string; clientId: string };
type WorkspaceGuestsResponse = {
  acceptedGuests: { userId: string }[];
  boards: { id: string }[];
  pendingInvites?: { id: string; boards?: { boardId: string }[] }[];
};
type GuestInviteResponse = { status: "added" | "invited"; token?: string; invite?: { id: string; boards?: { boardId: string }[] } };
type DueSlot = "anyTime" | "morning" | "afternoon" | "endOfWorkDay";

function utcLocalDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

void test("POST /workspaces creates workspace-scoped defaults and admin membership", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme",
      email: "owner@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<SignupResponse>();
  assert.equal(user.hasWorkspace, false);

  const created = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(created.statusCode, 201);
  const workspace = created.json<WorkspaceResponse>();

  const [ownerMembership] = await db
    .select()
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, workspace.id));
  assert.equal(ownerMembership?.userId, user.id);
  // The workspace creator is seeded as a workspace admin (the top workspace role).
  assert.equal(ownerMembership?.role, "admin");

  const workspaceResponse = await app.inject({
    method: "GET",
    url: `/workspaces/${workspace.id}`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(workspaceResponse.statusCode, 200);
  const body = workspaceResponse.json();

  assert.deepEqual(
    body.lists.map((list: { name: string; position: string }) => [list.name, list.position]),
    DEFAULT_WORKSPACE_LIST_NAMES.map((name, index) => [name, position(index)]),
  );
  assert.deepEqual(
    body.customFields.map((field: { name: string; icon: string; type: string; position: string }) => [
      field.name,
      field.icon,
      field.type,
      field.position,
    ]),
    DEFAULT_WORKSPACE_CUSTOM_FIELDS.map((field, index) => [field.name, field.icon, field.type, position(index)]),
  );
  assert.deepEqual(
    body.cardLabels.map((label: { name: string; color: string; position: string }) => [
      label.name,
      label.color,
      label.position,
    ]),
    DEFAULT_WORKSPACE_LABELS.map((label, index) => [label.name, label.color, position(index)]),
  );

  const workspaceLists = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id));
  const workspaceFields = await db.select().from(customFields).where(eq(customFields.workspaceId, workspace.id));
  assert.equal(workspaceLists.length, DEFAULT_WORKSPACE_LIST_NAMES.length);
  assert.equal(workspaceFields.length, DEFAULT_WORKSPACE_CUSTOM_FIELDS.length);
});

void test("POST /workspaces atomically seeds checklist templates, starter cards, and automation recipes", async () => {
  const app = await buildIntegrationServer();
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Seeded Org",
      email: "seeded-workspace-owner@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken } = signup.json<SignupResponse>();
  const auth = { authorization: `Bearer ${accessToken}` };

  const created = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: auth,
    payload: {
      name: "Client Delivery",
      initialBoard: { name: "Onboarding" },
      lists: [{ name: "Prep" }, { name: "Ready" }],
      customFields: [{ name: "Billing Month", icon: "calendar-month", type: "text" }],
      labels: [{ name: "Access", color: "blue" }],
      checklistTemplates: [{
        title: "Kickoff",
        items: ["Confirm goals", "Agree owners"],
      }],
      cards: [{
        title: "Run kickoff",
        description: "Align the delivery team and client.",
        listName: "Prep",
        labelNames: ["Access"],
        checklistTemplateTitles: ["Kickoff"],
      }],
      automations: [
        {
          trigger: { type: "card_enters_list", listName: "Prep" },
          actions: [{ type: "add_labels", labelNames: ["Access"] }],
        },
        {
          trigger: { type: "card_enters_list", listName: "Ready" },
          actions: [
            { type: "apply_checklists", checklistTemplateTitles: ["Kickoff"] },
            {
              type: "populate_custom_field",
              fieldName: "Billing Month",
              onlyIfEmpty: true,
              value: { kind: "text_current_date", format: "month" },
            },
          ],
        },
      ],
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  const result = created.json<{ id: string; initialBoard: { id: string } }>();

  const detail = await app.inject({ method: "GET", url: `/workspaces/${result.id}`, headers: auth });
  assert.equal(detail.statusCode, 200);
  assert.deepEqual(
    detail.json<{ checklistTemplates: { title: string; items: { text: string }[] }[] }>()
      .checklistTemplates.map((template) => ({ title: template.title, items: template.items.map((item) => item.text) })),
    [{ title: "Kickoff", items: ["Confirm goals", "Agree owners"] }],
  );

  const [starterCard] = await db.select().from(cards).where(eq(cards.boardId, result.initialBoard.id));
  assert.equal(starterCard?.title, "Run kickoff");
  assert.equal(starterCard?.description, "Align the delivery team and client.");
  assert.equal(await db.$count(cardLabelAssignments, eq(cardLabelAssignments.cardId, starterCard!.id)), 1);

  const [cardChecklist] = await db.select().from(cardChecklists).where(eq(cardChecklists.cardId, starterCard!.id));
  assert.equal(cardChecklist?.title, "Kickoff");
  const checklistItems = await db.select().from(cardChecklistItems).where(eq(cardChecklistItems.checklistId, cardChecklist!.id));
  assert.deepEqual(checklistItems.map((item) => item.text), ["Confirm goals", "Agree owners"]);

  const seededAutomations = (await db.select().from(automations).where(eq(automations.workspaceId, result.id)))
    .sort((a, b) => Number(a.position) - Number(b.position));
  assert.equal(seededAutomations.length, 2);
  assert.deepEqual(seededAutomations.map((automation) => automation.enabled), [true, true]);
  const seededLists = await db.select().from(lists).where(eq(lists.workspaceId, result.id));
  assert.equal(seededAutomations[0]?.triggerListId, seededLists.find((list) => list.name === "Prep")?.id);
  assert.equal(seededAutomations[1]?.triggerListId, seededLists.find((list) => list.name === "Ready")?.id);
  const firstActions = await db.select().from(automationActions).where(eq(automationActions.automationId, seededAutomations[0]!.id));
  const secondActions = (await db.select().from(automationActions).where(eq(automationActions.automationId, seededAutomations[1]!.id)))
    .sort((a, b) => Number(a.position) - Number(b.position));
  const [accessLabel] = await db.select().from(cardLabels).where(and(eq(cardLabels.workspaceId, result.id), eq(cardLabels.name, "Access")));
  const kickoffTemplate = detail.json<{ checklistTemplates: { id: string; title: string }[] }>().checklistTemplates.find((template) => template.title === "Kickoff");
  assert.deepEqual(firstActions[0]?.config, { labelIds: [accessLabel!.id] });
  assert.deepEqual(secondActions[0]?.config, { templateIds: [kickoffTemplate!.id] });
  const [billingMonthField] = await db.select().from(customFields).where(and(eq(customFields.workspaceId, result.id), eq(customFields.name, "Billing Month")));
  assert.deepEqual(secondActions[1]?.config, {
    fieldId: billingMonthField!.id,
    onlyIfEmpty: true,
    value: { kind: "text_current_date", format: "month" },
  });
});

void test("POST /workspaces keeps all template automation recipes disabled on hosted Free", async () => {
  const app = await buildIntegrationServer();
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Free Recipe Org",
      email: "free-automation-recipes@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken } = signup.json<SignupResponse>();
  const previousMode = env.KANERA_DEPLOYMENT_MODE;
  env.KANERA_DEPLOYMENT_MODE = "hosted";
  try {
    const created = await app.inject({
      method: "POST",
      url: "/workspaces",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        name: "Free Recipes",
        lists: [{ name: "Todo" }, { name: "Done" }],
        customFields: [],
        labels: [],
        automations: [
          {
            trigger: { type: "card_enters_list", listName: "Done" },
            actions: [{ type: "set_completion", completed: true }],
          },
          {
            trigger: { type: "card_enters_list", listName: "Todo" },
            actions: [{ type: "move_to_bottom" }],
          },
        ],
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const workspace = created.json<WorkspaceResponse>();
    const recipes = await db.select().from(automations).where(eq(automations.workspaceId, workspace.id));
    assert.equal(recipes.length, 2);
    assert.deepEqual(recipes.map((recipe) => recipe.enabled), [false, false]);
    assert.equal(await db.$count(automationActions, inArray(automationActions.automationId, recipes.map((recipe) => recipe.id))), 2);
  } finally {
    env.KANERA_DEPLOYMENT_MODE = previousMode;
  }
});

void test("standalone workspaces create one mirrored board and stay hidden from workspace surfaces", async () => {
  const app = await buildIntegrationServer();
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { orgName: "Standalone Org", email: "standalone-owner@example.com", password: "Abc12345", displayName: "Owner" },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<SignupResponse>();
  const auth = { authorization: `Bearer ${accessToken}` };

  const missingBoard = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: auth,
    payload: { kind: "board", name: "Missing board" },
  });
  assert.equal(missingBoard.statusCode, 400);

  const created = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: auth,
    payload: {
      kind: "board",
      name: "Client-supplied hidden name",
      icon: "alien",
      initialBoard: { name: "Launch plan", icon: "rocket", iconColor: "violet" },
      lists: [{ name: "Todo" }, { name: "Done" }],
      customFields: [{ name: "Owner note", type: "text" }],
      labels: [{ name: "Urgent", color: "red" }],
    },
  });
  assert.equal(created.statusCode, 201);
  const standalone = created.json<{
    id: string;
    kind: string;
    name: string;
    icon: string | null;
    accentColor: string | null;
    initialBoard: { id: string; workspaceId: string; name: string; icon: string | null; iconColor: string | null };
  }>();
  assert.equal(standalone.kind, "board");
  assert.equal(standalone.name, "Launch plan");
  assert.equal(standalone.icon, "rocket");
  assert.equal(standalone.accentColor, "violet");
  assert.equal(standalone.initialBoard.name, "Launch plan");
  assert.equal(standalone.initialBoard.icon, "rocket");
  assert.equal(standalone.initialBoard.iconColor, "violet");
  assert.equal(standalone.initialBoard.workspaceId, standalone.id);
  assert.equal(await db.$count(workspaceMembers, and(eq(workspaceMembers.workspaceId, standalone.id), eq(workspaceMembers.userId, user.id))), 1);
  assert.equal(await db.$count(boards, eq(boards.workspaceId, standalone.id)), 1);

  const detail = await app.inject({ method: "GET", url: `/workspaces/${standalone.id}`, headers: auth });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json<{ role: string }>().role, "admin");

  const listed = await app.inject({ method: "GET", url: "/workspaces", headers: auth });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json<{ id: string }[]>().some((workspace) => workspace.id === standalone.id), false);

  const [member] = await db.insert(users).values({
    clientId: user.clientId,
    clientRole: "member",
    email: "standalone-member@example.com",
    passwordHash: "hash",
    displayName: "Member",
  }).returning();
  assert.ok(member);
  await db.insert(workspaceMembers).values({ workspaceId: standalone.id, userId: member.id, role: "member" });
  const memberToken = app.jwt.sign({ sub: member.id, cid: user.clientId, role: "member" });
  const memberList = await app.inject({ method: "GET", url: "/workspaces", headers: { authorization: `Bearer ${memberToken}` } });
  assert.equal(memberList.statusCode, 200);
  assert.equal(memberList.json<{ id: string }[]>().some((workspace) => workspace.id === standalone.id), false);

  const home = await app.inject({ method: "GET", url: "/home/boards", headers: auth });
  assert.equal(home.statusCode, 200);
  const standaloneGroup = home.json<{ groups: { workspace: { id: string; kind: string }; boards: { id: string }[] }[] }>()
    .groups.find((group) => group.workspace.id === standalone.id);
  assert.ok(standaloneGroup);
  assert.equal(standaloneGroup.workspace.kind, "board");
  assert.deepEqual(standaloneGroup.boards.map((board) => board.id), [standalone.initialBoard.id]);

  const meWithOnlyStandalone = await app.inject({ method: "GET", url: "/me", headers: auth });
  assert.equal(meWithOnlyStandalone.statusCode, 200);
  assert.equal(meWithOnlyStandalone.json<{ hasWorkspace: boolean }>().hasWorkspace, false);

  const personalKeyResponse = await app.inject({ method: "POST", url: "/me/api-keys", headers: auth, payload: { label: "Standalone discovery" } });
  assert.equal(personalKeyResponse.statusCode, 201);
  const personalKey = personalKeyResponse.json<{ secret: string }>();
  const workspaceKeyResponse = await app.inject({
    method: "POST",
    url: `/workspaces/${standalone.id}/api-keys`,
    headers: auth,
    payload: { name: "Pinned standalone", scope: "read" },
  });
  assert.equal(workspaceKeyResponse.statusCode, 201);
  const workspaceKey = workspaceKeyResponse.json<{ secret: string }>();
  const publicApi = await buildPublicApiServer({ logger: false, uploadsDir: testUploadsDir("standalone-workspace-listing") });
  try {
    const personalList = await publicApi.inject({ method: "GET", url: "/api/v1/workspaces", headers: { authorization: `Bearer ${personalKey.secret}` } });
    assert.equal(personalList.statusCode, 200);
    assert.equal(personalList.json<{ id: string }[]>().some((workspace) => workspace.id === standalone.id), false);

    const pinnedList = await publicApi.inject({ method: "GET", url: "/api/v1/workspaces", headers: { authorization: `Bearer ${workspaceKey.secret}` } });
    assert.equal(pinnedList.statusCode, 200);
    assert.deepEqual(pinnedList.json<{ id: string; kind: string }[]>().map(({ id, kind }) => ({ id, kind })), [{ id: standalone.id, kind: "board" }]);
  } finally {
    await publicApi.close();
  }

  const renamed = await app.inject({
    method: "PATCH",
    url: `/workspaces/${standalone.id}`,
    headers: auth,
    payload: { name: "Launch renamed", icon: "plane", accentColor: "teal" },
  });
  assert.equal(renamed.statusCode, 200);
  const renamedBody = renamed.json<{ name: string; icon: string | null; accentColor: string | null }>();
  assert.equal(renamedBody.name, "Launch renamed");
  assert.equal(renamedBody.icon, "plane");
  assert.equal(renamedBody.accentColor, "teal");
  const mirroredBoard = await app.inject({ method: "GET", url: `/boards/${standalone.initialBoard.id}`, headers: auth });
  assert.equal(mirroredBoard.statusCode, 200);
  const mirroredBoardBody = mirroredBoard.json<{ name: string; icon: string | null; iconColor: string | null }>();
  assert.equal(mirroredBoardBody.name, "Launch renamed");
  assert.equal(mirroredBoardBody.icon, "plane");
  assert.equal(mirroredBoardBody.iconColor, "teal");

  const hiddenGrant = await app.inject({
    method: "POST",
    url: "/clients/me/invites",
    headers: auth,
    payload: { orgRole: "member", workspaces: [{ workspaceId: standalone.id, role: "member" }] },
  });
  assert.equal(hiddenGrant.statusCode, 400);

  const standardCreated = await app.inject({ method: "POST", url: "/workspaces", headers: auth, payload: { name: "Visible workspace" } });
  assert.equal(standardCreated.statusCode, 201);
  const standard = standardCreated.json<{ id: string; kind: string }>();
  assert.equal(standard.kind, "standard");
  const meWithStandard = await app.inject({ method: "GET", url: "/me", headers: auth });
  assert.equal(meWithStandard.json<{ hasWorkspace: boolean }>().hasWorkspace, true);

  const deleted = await app.inject({ method: "DELETE", url: `/workspaces/${standalone.id}`, headers: auth });
  assert.equal(deleted.statusCode, 204);
  assert.equal(await db.$count(workspaces, eq(workspaces.id, standalone.id)), 0);
  assert.equal(await db.$count(boards, eq(boards.id, standalone.initialBoard.id)), 0);
});

void test("POST /workspaces accepts explicit empty onboarding setup", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Blank Co",
      email: "blank-owner@example.com",
      password: "Abc12345",
      displayName: "Blank Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken } = signup.json<SignupResponse>();

  const created = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: {
      name: "Empty Workspace",
      icon: "layout-kanban",
      lists: [],
      customFields: [],
      labels: [],
    },
  });
  assert.equal(created.statusCode, 201);
  const workspace = created.json<WorkspaceResponse & { initialBoard?: unknown }>();
  assert.equal(workspace.initialBoard, undefined);

  const workspaceLists = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id));
  const workspaceFields = await db.select().from(customFields).where(eq(customFields.workspaceId, workspace.id));
  const workspaceLabels = await db.select().from(cardLabels).where(eq(cardLabels.workspaceId, workspace.id));
  const workspaceBoards = await db.select().from(boards).where(eq(boards.workspaceId, workspace.id));

  assert.equal(workspaceLists.length, 0);
  assert.equal(workspaceFields.length, 0);
  assert.equal(workspaceLabels.length, 0);
  assert.equal(workspaceBoards.length, 0);
});

void test("workspace analytics milestones are durably claimed at the approved thresholds", async () => {
  const app = await buildIntegrationServer();
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Activation Org",
      email: "activation-owner@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<SignupResponse>();
  const auth = { authorization: `Bearer ${accessToken}` };
  const created = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: auth,
    payload: { name: "Activated", initialBoard: { name: "First board" } },
  });
  assert.equal(created.statusCode, 201);
  const workspace = created.json<{ id: string }>();

  const [board] = await db.select({ id: boards.id }).from(boards).where(eq(boards.workspaceId, workspace.id)).limit(1);
  const [list] = await db.select({ id: lists.id }).from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(board);
  assert.ok(list);
  // Mirror convergence creates a real destination card but attributes its activity to the system.
  // Seed that shape before user work so the pre-threshold assertion proves it is not counted.
  const [mirrorCopy] = await db.insert(cards).values({
    boardId: board.id,
    listId: list.id,
    title: "System-created mirror copy",
    position: "9000.0000000000",
    createdById: user.id,
  }).returning({ id: cards.id });
  assert.ok(mirrorCopy);
  await db.insert(activityEvents).values({
    boardId: board.id,
    workspaceId: workspace.id,
    actorId: user.id,
    actorKind: "system",
    entityType: "card",
    entityId: mirrorCopy.id,
    action: "created",
    payload: { mirrorId: "00000000-0000-4000-8000-000000000001" },
  });
  for (const title of ["First", "Second"]) {
    assert.equal((await app.inject({
      method: "POST",
      url: `/boards/${board.id}/lists/${list.id}/cards`,
      headers: auth,
      payload: { title },
    })).statusCode, 201);
  }
  const [beforeThreshold] = await db.select().from(workspaceAnalyticsMilestones)
    .where(eq(workspaceAnalyticsMilestones.workspaceId, workspace.id));
  assert.equal(beforeThreshold?.meaningfulWorkCreatedAt, null);

  const key = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/api-keys`,
    headers: auth,
    payload: { name: "Activation API", scope: "write" },
  });
  assert.equal(key.statusCode, 201);
  const publicApi = await buildPublicApiServer({
    logger: false,
    rateLimit: { enabled: false },
    uploadsDir: testUploadsDir("analytics-milestone-public-api"),
  });
  try {
    const thirdCard = await publicApi.inject({
      method: "POST",
      url: `/api/v1/boards/${board.id}/lists/${list.id}/cards`,
      headers: { authorization: `Bearer ${key.json<{ secret: string }>().secret}` },
      payload: { title: "Third through API" },
    });
    assert.equal(thirdCard.statusCode, 201);
  } finally {
    await publicApi.close();
  }
  const [meaningful] = await db.select().from(workspaceAnalyticsMilestones)
    .where(eq(workspaceAnalyticsMilestones.workspaceId, workspace.id));
  assert.ok(meaningful?.meaningfulWorkCreatedAt);

  const fourthCard = await app.inject({
    method: "POST",
    url: `/boards/${board.id}/lists/${list.id}/cards`,
    headers: auth,
    payload: { title: "Fourth" },
  });
  assert.equal(fourthCard.statusCode, 201);
  const [afterRetry] = await db.select().from(workspaceAnalyticsMilestones)
    .where(eq(workspaceAnalyticsMilestones.workspaceId, workspace.id));
  assert.equal(afterRetry?.meaningfulWorkCreatedAt?.getTime(), meaningful.meaningfulWorkCreatedAt.getTime());
  assert.equal(afterRetry?.collaborationStartedAt, null);

  const [collaborator] = await db.insert(users).values({
    clientId: user.clientId,
    email: "activation-collaborator@example.com",
    passwordHash: "x",
    displayName: "Collaborator",
  }).returning();
  assert.ok(collaborator);
  await db.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: collaborator.id, role: "member" });
  await db.insert(boardMembers).values({ boardId: board.id, userId: collaborator.id, role: "editor" });
  const collaboratorToken = app.jwt.sign({ sub: collaborator.id, cid: user.clientId, role: "member" });
  const collaboratorAction = await app.inject({
    method: "POST",
    url: `/boards/${board.id}/lists/${list.id}/cards`,
    headers: { authorization: `Bearer ${collaboratorToken}` },
    payload: { title: "Shared work" },
  });
  assert.equal(collaboratorAction.statusCode, 201);
  const [collaborative] = await db.select().from(workspaceAnalyticsMilestones)
    .where(eq(workspaceAnalyticsMilestones.workspaceId, workspace.id));
  assert.ok(collaborative?.collaborationStartedAt);
});

void test("adding a workspace member emits directly to the newly added user", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Workspace Add Realtime Org",
      email: "workspace-add-owner@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<SignupResponse>();

  const created = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Realtime Workspace" },
  });
  assert.equal(created.statusCode, 201);
  const workspace = created.json<WorkspaceResponse>();

  const [member] = await db
    .insert(users)
    .values({
      clientId: user.clientId,
      email: "workspace-add-member@example.com",
      passwordHash: "hash",
      displayName: "Member",
      clientRole: "admin",
    })
    .returning();
  assert.ok(member);

  const add = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/members`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { userId: member.id, role: "member" },
  });
  assert.equal(add.statusCode, 200);
  const addedAdmin = add.json<{ role: string; orgRole: string }>();
  assert.equal(addedAdmin.role, "admin");
  assert.equal(addedAdmin.orgRole, "admin");

  const listedMembers = await app.inject({
    method: "GET",
    url: `/workspaces/${workspace.id}/members`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(listedMembers.statusCode, 200);
  const inheritedRows = listedMembers.json<{ userId: string; role: string; orgRole: string }[]>();
  assert.ok(inheritedRows.some((row) => row.userId === user.id && row.role === "admin" && row.orgRole === "owner"));
  assert.ok(inheritedRows.some((row) => row.userId === member.id && row.role === "admin" && row.orgRole === "admin"));

  const downgradeInheritedAdmin = await app.inject({
    method: "PATCH",
    url: `/workspaces/${workspace.id}/members/${member.id}`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { role: "member" },
  });
  assert.equal(downgradeInheritedAdmin.statusCode, 400);

  const removeInheritedAdmin = await app.inject({
    method: "DELETE",
    url: `/workspaces/${workspace.id}/members/${member.id}`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(removeInheritedAdmin.statusCode, 400);

  let directRows: { userId: string | null; eventType: string; payload: unknown }[] = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    directRows = await db
      .select({ userId: directRealtimeOutbox.userId, eventType: directRealtimeOutbox.eventType, payload: directRealtimeOutbox.payload })
      .from(directRealtimeOutbox)
      .where(and(eq(directRealtimeOutbox.scope, "user"), eq(directRealtimeOutbox.userId, member.id), eq(directRealtimeOutbox.eventType, "workspace:member:added")));
    if (directRows.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(directRows.length, 1);
  const payload = directRows[0]!.payload as { workspaceId: string; member: { workspaceId: string; userId: string; role: string; email: string; displayName: string } };
  assert.equal(payload.workspaceId, workspace.id);
  assert.equal(payload.member.workspaceId, workspace.id);
  assert.equal(payload.member.userId, member.id);
  assert.equal(payload.member.role, "admin");
  assert.equal(payload.member.email, "workspace-add-member@example.com");
  assert.equal(payload.member.displayName, "Member");

  const [ordinaryMember] = await db.insert(users).values({
    clientId: user.clientId,
    email: "workspace-role-member@example.com",
    passwordHash: "hash",
    displayName: "Workspace Role Member",
    clientRole: "member",
  }).returning();
  const [roleBoard] = await db.insert(boards).values({ workspaceId: workspace.id, name: "Role Board", position: "1000.0000000000" }).returning();
  assert.ok(ordinaryMember && roleBoard);
  await db.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: ordinaryMember.id, role: "member" });
  await db.insert(boardMembers).values({ boardId: roleBoard.id, userId: ordinaryMember.id, role: "observer", assignedItemsOnly: true });

  const promoteWorkspaceAdmin = await app.inject({
    method: "PATCH",
    url: `/workspaces/${workspace.id}/members/${ordinaryMember.id}`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { role: "admin" },
  });
  assert.equal(promoteWorkspaceAdmin.statusCode, 200);
  const demoteWorkspaceMember = await app.inject({
    method: "PATCH",
    url: `/workspaces/${workspace.id}/members/${ordinaryMember.id}`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { role: "member" },
  });
  assert.equal(demoteWorkspaceMember.statusCode, 200);
  const [retainedBoardAccess] = await db.select({ role: boardMembers.role, pinned: boardMembers.pinned, assignedItemsOnly: boardMembers.assignedItemsOnly })
    .from(boardMembers)
    .where(and(eq(boardMembers.boardId, roleBoard.id), eq(boardMembers.userId, ordinaryMember.id)))
    .limit(1);
  assert.deepEqual(retainedBoardAccess, { role: "editor", pinned: false, assignedItemsOnly: false });
});

void test("removing a workspace member clears live board access, assignments, watches, mentions, and workspace notifications", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Workspace Remove Cleanup Org",
      email: "workspace-remove-owner@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<SignupResponse>();

  const created = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Cleanup Workspace" },
  });
  assert.equal(created.statusCode, 201);
  const workspace = created.json<WorkspaceResponse>();

  const [member] = await db
    .insert(users)
    .values({
      clientId: user.clientId,
      email: "workspace-remove-member@example.com",
      passwordHash: "hash",
      displayName: "Member",
      clientRole: "member",
    })
    .returning();
  assert.ok(member);
  const [boardRow] = await db.insert(boards).values({ workspaceId: workspace.id, name: "Private Board", position: "1000.0000000000" }).returning();
  const [list] = await db.insert(lists).values({ workspaceId: workspace.id, name: "Todo", position: "1000.0000000000" }).returning();
  const [card] = await db.insert(cards).values({ boardId: boardRow!.id, listId: list!.id, title: "Assigned", position: "1000.0000000000", createdById: user.id }).returning();
  const [otherWorkspace] = await db.insert(workspaces).values({ clientId: user.clientId, name: "Other Workspace" }).returning();
  const [otherBoard] = await db.insert(boards).values({ workspaceId: otherWorkspace!.id, name: "Other Board", position: "1000.0000000000" }).returning();
  const [otherList] = await db.insert(lists).values({ workspaceId: otherWorkspace!.id, name: "Todo", position: "1000.0000000000" }).returning();
  const [otherCard] = await db.insert(cards).values({ boardId: otherBoard!.id, listId: otherList!.id, title: "Still visible", position: "1000.0000000000", createdById: user.id }).returning();

  await db.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: member.id, role: "member" });
  await db.insert(workspaceMembers).values({ workspaceId: otherWorkspace!.id, userId: member.id, role: "member" });
  await db.insert(boardMembers).values({ boardId: boardRow!.id, userId: member.id, role: "editor" });
  await db.insert(boardWatchers).values({ boardId: boardRow!.id, userId: member.id });
  await db.insert(cardAssignees).values({ cardId: card!.id, userId: member.id });
  const [removedChecklist] = await db.insert(cardChecklists).values({ cardId: card!.id, title: "Removed workspace", position: "1000.0000000000" }).returning();
  const [removedChecklistItem] = await db.insert(cardChecklistItems).values({ checklistId: removedChecklist!.id, text: "Assigned", position: "1000.0000000000", assigneeId: member.id }).returning();
  const [retainedChecklist] = await db.insert(cardChecklists).values({ cardId: otherCard!.id, title: "Other workspace", position: "1000.0000000000" }).returning();
  const [retainedChecklistItem] = await db.insert(cardChecklistItems).values({ checklistId: retainedChecklist!.id, text: "Still assigned", position: "1000.0000000000", assigneeId: member.id }).returning();
  await db.insert(cardWatchers).values({ cardId: card!.id, userId: member.id });
  await db.insert(cardMentions).values({ cardId: card!.id, userId: member.id, source: "description" });
  const [removedWorkspaceNotification] = await db.insert(notifications).values({
    userId: member.id,
    cardId: card!.id,
    listId: list!.id,
    boardId: boardRow!.id,
    workspaceId: workspace.id,
    reason: "assigned",
  }).returning();
  const [retainedWorkspaceNotification] = await db.insert(notifications).values({
    userId: member.id,
    cardId: otherCard!.id,
    listId: otherList!.id,
    boardId: otherBoard!.id,
    workspaceId: otherWorkspace!.id,
    reason: "assigned",
  }).returning();

  const removed = await app.inject({
    method: "DELETE",
    url: `/workspaces/${workspace.id}/members/${member.id}`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(removed.statusCode, 204);
  assert.equal(await db.$count(workspaceMembers, and(eq(workspaceMembers.workspaceId, workspace.id), eq(workspaceMembers.userId, member.id))), 0);
  assert.equal(await db.$count(boardMembers, and(eq(boardMembers.boardId, boardRow!.id), eq(boardMembers.userId, member.id))), 0);
  assert.equal(await db.$count(boardWatchers, and(eq(boardWatchers.boardId, boardRow!.id), eq(boardWatchers.userId, member.id))), 0);
  assert.equal(await db.$count(cardAssignees, and(eq(cardAssignees.cardId, card!.id), eq(cardAssignees.userId, member.id))), 0);
  assert.equal((await db.select({ assigneeId: cardChecklistItems.assigneeId }).from(cardChecklistItems).where(eq(cardChecklistItems.id, removedChecklistItem!.id)))[0]?.assigneeId, null);
  assert.equal((await db.select({ assigneeId: cardChecklistItems.assigneeId }).from(cardChecklistItems).where(eq(cardChecklistItems.id, retainedChecklistItem!.id)))[0]?.assigneeId, member.id);
  assert.equal(await db.$count(cardWatchers, and(eq(cardWatchers.cardId, card!.id), eq(cardWatchers.userId, member.id))), 0);
  assert.equal(await db.$count(cardMentions, and(eq(cardMentions.cardId, card!.id), eq(cardMentions.userId, member.id))), 0);
  assert.equal(await db.$count(notifications, eq(notifications.id, removedWorkspaceNotification!.id)), 0);
  assert.equal(await db.$count(notifications, eq(notifications.id, retainedWorkspaceNotification!.id)), 1);
  let notificationReadRows: { payload: unknown }[] = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    notificationReadRows = await db
      .select({ payload: directRealtimeOutbox.payload })
      .from(directRealtimeOutbox)
      .where(and(eq(directRealtimeOutbox.scope, "user"), eq(directRealtimeOutbox.userId, member.id), eq(directRealtimeOutbox.eventType, "notification:read")));
    if (notificationReadRows.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(notificationReadRows.some((row) => {
    const payload = row.payload as { notificationIds?: string[] };
    return payload.notificationIds?.includes(removedWorkspaceNotification!.id) === true
      && payload.notificationIds.includes(retainedWorkspaceNotification!.id) === false;
  }));

  const readded = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/members`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { userId: member.id, role: "member" },
  });
  assert.equal(readded.statusCode, 200);
  assert.equal(await db.$count(cardAssignees, and(eq(cardAssignees.cardId, card!.id), eq(cardAssignees.userId, member.id))), 0);
  assert.equal((await db.select({ assigneeId: cardChecklistItems.assigneeId }).from(cardChecklistItems).where(eq(cardChecklistItems.id, removedChecklistItem!.id)))[0]?.assigneeId, null);
});

void test("POST /workspaces can create an initial board for onboarding", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Starter Co",
      email: "starter@example.com",
      password: "Abc12345",
      displayName: "Starter",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<SignupResponse>();

  const created = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: {
      name: "Client Delivery",
      initialBoard: { name: "Acme", icon: "building" },
      lists: [
        { name: "Incoming", icon: "inbox" },
        { name: "Complete", icon: "circle-check" },
      ],
    },
  });
  assert.equal(created.statusCode, 201);
  const body = created.json<WorkspaceResponse & { initialBoard: { id: string; name: string; icon: string | null; workspaceId: string } }>();

  assert.equal(body.initialBoard.name, "Acme");
  assert.equal(body.initialBoard.icon, "building");
  assert.equal(body.initialBoard.workspaceId, body.id);

  const [row] = await db.select().from(boards).where(eq(boards.id, body.initialBoard.id));
  assert.equal(row?.name, "Acme");
  assert.equal(row?.workspaceId, body.id);

  const workspaceLists = await db.select().from(lists).where(eq(lists.workspaceId, body.id));
  assert.deepEqual(
    workspaceLists.map((list) => [list.name, list.icon]),
    [
      ["Incoming", "inbox"],
      ["Complete", "circle-check"],
    ],
  );

  let directRows: { userId: string | null; eventType: string; payload: unknown }[] = [];
  let boardCreatedRows: { workspaceId: string | null; eventType: string; payload: unknown }[] = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    [directRows, boardCreatedRows] = await Promise.all([
      db
        .select({ userId: directRealtimeOutbox.userId, eventType: directRealtimeOutbox.eventType, payload: directRealtimeOutbox.payload })
        .from(directRealtimeOutbox)
        .where(and(eq(directRealtimeOutbox.scope, "user"), eq(directRealtimeOutbox.userId, user.id), eq(directRealtimeOutbox.eventType, "workspace:member:added"))),
      db
        .select({ workspaceId: eventOutbox.workspaceId, eventType: eventOutbox.eventType, payload: eventOutbox.payload })
        .from(eventOutbox)
        .where(and(eq(eventOutbox.workspaceId, body.id), eq(eventOutbox.eventType, "board:created"))),
    ]);
    if (directRows.length > 0 && boardCreatedRows.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(directRows.length, 1);
  const directPayload = directRows[0]!.payload as { workspaceId: string; member: { workspaceId: string; userId: string; role: string } };
  assert.equal(directPayload.workspaceId, body.id);
  assert.equal(directPayload.member.workspaceId, body.id);
  assert.equal(directPayload.member.userId, user.id);
  assert.equal(directPayload.member.role, "admin");

  assert.equal(boardCreatedRows.length, 1);
  const boardPayload = boardCreatedRows[0]!.payload as { workspaceId: string; board: { id: string; workspaceId: string; name: string } };
  assert.equal(boardPayload.workspaceId, body.id);
  assert.equal(boardPayload.board.id, body.initialBoard.id);
  assert.equal(boardPayload.board.workspaceId, body.id);
});

void test("GET /home/boards overdue stats ignore completed cards", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme",
      email: "owner@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<SignupResponse>();

  const created = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(created.statusCode, 201);
  const workspace = created.json<WorkspaceResponse>();
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Public", position: "1000.0000000000" })
    .returning();
  const [completedOverdue] = await db
    .insert(cards)
    .values({
      listId: list!.id,
      boardId: board!.id,
      title: "Done late",
      position: "1000.0000000000",
      createdById: user.id,
      dueDateLocalDate: "2026-05-20",
      dueDateSlot: "anyTime",
      completedAt: new Date("2026-05-21T10:00:00.000Z"),
    })
    .returning();
  await db.insert(cardAssignees).values({ cardId: completedOverdue!.id, userId: user.id });

  const home = await app.inject({
    method: "GET",
    url: "/home/boards",
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(home.statusCode, 200);
  const homeBody = home.json<{ groups: { boards: { id: string; myOverdue: number }[] }[] }>();
  const homeBoard = homeBody.groups[0]?.boards.find((b) => b.id === board!.id);
  assert.ok(homeBoard);
  assert.equal(homeBoard.myOverdue, 0);
});

void test("GET /home/boards includes assigned cards due today and tomorrow in due-soon order", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Due Soon",
      email: "due-soon-owner@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<SignupResponse>();

  const created = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(created.statusCode, 201);
  const workspace = created.json<WorkspaceResponse>();
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Alpha Board", icon: "rocket", position: "1000.0000000000" })
    .returning();
  assert.ok(board);

  const today = utcLocalDate(new Date());
  const [yearString, monthString, dayString] = today.split("-");
  const year = Number(yearString);
  const month = Number(monthString);
  const day = Number(dayString);
  const tomorrowDate = new Date(Date.UTC(year, month - 1, day + 1));
  const tomorrow = `${tomorrowDate.getUTCFullYear()}-${String(tomorrowDate.getUTCMonth() + 1).padStart(2, "0")}-${String(tomorrowDate.getUTCDate()).padStart(2, "0")}`;
  const laterDate = new Date(Date.UTC(year, month - 1, day + 2));
  const later = `${laterDate.getUTCFullYear()}-${String(laterDate.getUTCMonth() + 1).padStart(2, "0")}-${String(laterDate.getUTCDate()).padStart(2, "0")}`;

  async function insertCard(
    title: string,
    dueDateLocalDate: string,
    dueDateSlot: DueSlot | null,
    options: { assigned?: boolean; completed?: boolean; archived?: boolean; boardId?: string; listId?: string } = {},
  ) {
    const [card] = await db
      .insert(cards)
      .values({
        listId: options.listId ?? list!.id,
        boardId: options.boardId ?? board!.id,
        title,
        position: "1000.0000000000",
        createdById: user.id,
        dueDateLocalDate,
        dueDateSlot,
        dueDateTimezone: "UTC",
        completedAt: options.completed ? new Date() : null,
        archivedAt: options.archived ? new Date() : null,
      })
      .returning();
    assert.ok(card);
    if (options.assigned ?? true) await db.insert(cardAssignees).values({ cardId: card.id, userId: user.id });
    return card;
  }

  await insertCard("Today any time", today, "anyTime");
  await insertCard("Today morning", today, "morning");
  await insertCard("Tomorrow morning", tomorrow, "morning");
  await insertCard("Later", later, "morning");
  await insertCard("Unassigned", today, "morning", { assigned: false });
  await insertCard("Completed", today, "morning", { completed: true });
  await insertCard("Archived", today, "morning", { archived: true });

  const hostSignup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Host Due Soon",
      email: "due-soon-host@example.com",
      password: "Abc12345",
      displayName: "Host",
    },
  });
  assert.equal(hostSignup.statusCode, 200);
  const { accessToken: hostToken } = hostSignup.json<SignupResponse>();
  const hostWorkspaceResponse = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${hostToken}` },
    payload: { name: "Host Workspace" },
  });
  assert.equal(hostWorkspaceResponse.statusCode, 201);
  const hostWorkspace = hostWorkspaceResponse.json<WorkspaceResponse>();
  const [hostList] = await db.select().from(lists).where(eq(lists.workspaceId, hostWorkspace.id)).limit(1);
  assert.ok(hostList);
  const [guestBoard] = await db
    .insert(boards)
    .values({ workspaceId: hostWorkspace.id, name: "Guest Board", position: "1000.0000000000" })
    .returning();
  assert.ok(guestBoard);
  await db.insert(boardMembers).values({ boardId: guestBoard.id, userId: user.id, role: "editor" });
  await insertCard("Guest tomorrow afternoon", tomorrow, "afternoon", { boardId: guestBoard.id, listId: hostList!.id });

  const [inaccessibleBoard] = await db
    .insert(boards)
    .values({ workspaceId: hostWorkspace.id, name: "Hidden Board", position: "2000.0000000000" })
    .returning();
  assert.ok(inaccessibleBoard);
  await insertCard("Inaccessible", today, "morning", { boardId: inaccessibleBoard.id, listId: hostList!.id });

  const home = await app.inject({
    method: "GET",
    url: "/home/boards",
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(home.statusCode, 200);
  const body = home.json<{ dueSoon: { title: string; boardName: string; boardIcon: string | null; dueDateLocalDate: string; dueDateSlot: string | null }[] }>();

  assert.deepEqual(body.dueSoon.map((card) => card.title), [
    "Today morning",
    "Today any time",
    "Tomorrow morning",
    "Guest tomorrow afternoon",
  ]);
  assert.deepEqual(body.dueSoon.map((card) => card.boardName), [
    "Alpha Board",
    "Alpha Board",
    "Alpha Board",
    "Guest Board",
  ]);
  assert.deepEqual(body.dueSoon.map((card) => card.boardIcon), [
    "rocket",
    "rocket",
    "rocket",
    "layout-kanban",
  ]);
  assert.deepEqual(body.dueSoon.map((card) => [card.dueDateLocalDate, card.dueDateSlot]), [
    [today, "morning"],
    [today, "anyTime"],
    [tomorrow, "morning"],
    [tomorrow, "afternoon"],
  ]);
});

void test("workspace guest management lists, invites, revokes, and removes external board guests", async () => {
  const app = await buildIntegrationServer();

  const hostSignup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Host Guests",
      email: "host-guests-owner@example.com",
      password: "Abc12345",
      displayName: "Host Owner",
    },
  });
  assert.equal(hostSignup.statusCode, 200);
  const { accessToken: hostToken, user: hostUser } = hostSignup.json<SignupResponse>();

  const created = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${hostToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(created.statusCode, 201);
  const workspace = created.json<WorkspaceResponse>();

  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Guest Board", position: "1000.0000000000" })
    .returning();
  assert.ok(board);

  const externalSignup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "External Org",
      email: "external-guest-settings@external.test",
      password: "Abc12345",
      displayName: "External Guest",
    },
  });
  assert.equal(externalSignup.statusCode, 200);
  const { user: externalUser } = externalSignup.json<SignupResponse>();

  const sameOrgUser = await db
    .insert(users)
    .values({
      clientId: hostUser.clientId,
      email: "same-org-board-member@example.com",
      passwordHash: "hash",
      displayName: "Same Org",
      clientRole: "member",
    })
    .returning();
  assert.ok(sameOrgUser[0]);
  await db.insert(boardMembers).values([
    { boardId: board.id, userId: externalUser.id, role: "editor" },
    { boardId: board.id, userId: sameOrgUser[0]!.id, role: "editor" },
  ]);
  const [list] = await db.insert(lists).values({ workspaceId: workspace.id, name: "Guest work", position: "1000.0000000000" }).returning();
  const [card] = await db.insert(cards).values({ boardId: board.id, listId: list!.id, title: "Guest assignment", position: "1000.0000000000", createdById: hostUser.id }).returning();
  await db.insert(cardAssignees).values({ cardId: card!.id, userId: externalUser.id });
  const [checklist] = await db.insert(cardChecklists).values({ cardId: card!.id, title: "Guest checklist", position: "1000.0000000000" }).returning();
  const [item] = await db.insert(cardChecklistItems).values({ checklistId: checklist!.id, text: "Guest item", position: "1000.0000000000", assigneeId: externalUser.id }).returning();

  const initial = await app.inject({
    method: "GET",
    url: `/workspaces/${workspace.id}/guests`,
    headers: { authorization: `Bearer ${hostToken}` },
  });
  assert.equal(initial.statusCode, 200);
  const initialBody = initial.json<WorkspaceGuestsResponse>();
  assert.equal(initialBody.acceptedGuests.length, 1);
  assert.equal(initialBody.acceptedGuests[0]?.userId, externalUser.id);
  assert.equal(initialBody.boards.some((b) => b.id === board.id), true);

  const rejectSameOrgThroughGuestRoute = await app.inject({
    method: "DELETE",
    url: `/workspaces/${workspace.id}/guests/${board.id}/${sameOrgUser[0]!.id}`,
    headers: { authorization: `Bearer ${hostToken}` },
  });
  assert.equal(rejectSameOrgThroughGuestRoute.statusCode, 400);
  assert.equal(await db.$count(boardMembers, and(eq(boardMembers.boardId, board.id), eq(boardMembers.userId, sameOrgUser[0]!.id))), 1);

  const adminInvite = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/guests/invitations`,
    headers: { authorization: `Bearer ${hostToken}` },
    payload: { boardId: board.id, email: "admin-board-guest@example.com", role: "admin" },
  });
  assert.equal(adminInvite.statusCode, 400);

  const ownerDomainInvite = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/guests/invitations`,
    headers: { authorization: `Bearer ${hostToken}` },
    payload: { boardId: board.id, email: "contractor@example.com", role: "editor" },
  });
  assert.equal(ownerDomainInvite.statusCode, 400);
  assert.match(ownerDomainInvite.json<{ message: string }>().message, /owner email domain/);

  const pending = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/guests/invitations`,
    headers: { authorization: `Bearer ${hostToken}` },
    payload: { boardId: board.id, email: "pending-board-guest@external.test", role: "observer" },
  });
  assert.equal(pending.statusCode, 201);
  const pendingBody = pending.json<GuestInviteResponse>();
  assert.equal(pendingBody.status, "invited");
  assert.equal(typeof pendingBody.token, "string");
  const [invite] = await db.select().from(boardInvitations).where(eq(boardInvitations.email, "pending-board-guest@external.test")).limit(1);
  assert.ok(invite);

  const duplicatePending = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/guests/invitations`,
    headers: { authorization: `Bearer ${hostToken}` },
    payload: { boardId: board.id, email: "pending-board-guest@external.test", role: "observer" },
  });
  assert.equal(duplicatePending.statusCode, 409);
  const pendingInviteRows = await db.select().from(boardInvitations).where(eq(boardInvitations.email, "pending-board-guest@external.test"));
  assert.equal(pendingInviteRows.length, 1);

  const revoke = await app.inject({
    method: "DELETE",
    url: `/workspaces/${workspace.id}/guests/invitations/${invite.id}`,
    headers: { authorization: `Bearer ${hostToken}` },
  });
  assert.equal(revoke.statusCode, 204);

  const remove = await app.inject({
    method: "DELETE",
    url: `/workspaces/${workspace.id}/guests/${board.id}/${externalUser.id}`,
    headers: { authorization: `Bearer ${hostToken}` },
  });
  assert.equal(remove.statusCode, 200);
  assert.equal(remove.json<{ paidGuestSeatRemoved: boolean }>().paidGuestSeatRemoved, false);
  assert.equal(await db.$count(cardAssignees, and(eq(cardAssignees.cardId, card!.id), eq(cardAssignees.userId, externalUser.id))), 0);
  assert.equal((await db.select({ assigneeId: cardChecklistItems.assigneeId }).from(cardChecklistItems).where(eq(cardChecklistItems.id, item!.id)))[0]?.assigneeId, null);
  const cleanupEvents = await db.select({ eventType: eventOutbox.eventType }).from(eventOutbox)
    .where(and(eq(eventOutbox.boardId, board.id), inArray(eventOutbox.eventType, ["card:assignees:set", "card:checklistItem:updated"])));
  assert.deepEqual(new Set(cleanupEvents.map((row) => row.eventType)), new Set(["card:assignees:set", "card:checklistItem:updated"]));

  const after = await app.inject({
    method: "GET",
    url: `/workspaces/${workspace.id}/guests`,
    headers: { authorization: `Bearer ${hostToken}` },
  });
  assert.equal(after.statusCode, 200);
  assert.equal(after.json<WorkspaceGuestsResponse>().acceptedGuests.length, 0);
});

void test("workspace guest invitations reuse one pending invite per email and acceptance grants all boards", async () => {
  const app = await buildIntegrationServer();

  const hostSignup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Bundled Guest Host",
      email: "bundled-guest-owner@example.com",
      password: "Abc12345",
      displayName: "Host Owner",
    },
  });
  assert.equal(hostSignup.statusCode, 200);
  const { accessToken: hostToken } = hostSignup.json<SignupResponse>();

  const wsCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${hostToken}` },
    payload: { name: "Host Workspace" },
  });
  assert.equal(wsCreated.statusCode, 201);
  const workspace = wsCreated.json<WorkspaceResponse>();

  const workspaceBoards = await db
    .insert(boards)
    .values([
      { workspaceId: workspace.id, name: "Board A", position: "1000.0000000000" },
      { workspaceId: workspace.id, name: "Board B", position: "2000.0000000000" },
    ])
    .returning();
  assert.equal(workspaceBoards.length, 2);

  const firstInvite = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/guests/invitations`,
    headers: { authorization: `Bearer ${hostToken}` },
    payload: { boardId: workspaceBoards[0]!.id, email: "bundled-guest@external.test", role: "observer" },
  });
  assert.equal(firstInvite.statusCode, 201, firstInvite.body);
  const firstInviteBody = firstInvite.json<GuestInviteResponse>();
  assert.equal(firstInviteBody.status, "invited");
  assert.equal(typeof firstInviteBody.token, "string");

  const secondInvite = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/guests/invitations`,
    headers: { authorization: `Bearer ${hostToken}` },
    payload: { boardId: workspaceBoards[1]!.id, email: "bundled-guest@external.test", role: "editor" },
  });
  assert.equal(secondInvite.statusCode, 201, secondInvite.body);
  const secondInviteBody = secondInvite.json<GuestInviteResponse>();
  assert.equal(secondInviteBody.status, "invited");
  assert.equal(typeof secondInviteBody.token, "string");
  assert.notEqual(secondInviteBody.token, firstInviteBody.token);
  assert.equal(secondInviteBody.invite?.id, firstInviteBody.invite?.id);

  const staleLookup = await app.inject({
    method: "GET",
    url: `/board-invitations/lookup?token=${encodeURIComponent(firstInviteBody.token!)}`,
  });
  assert.equal(staleLookup.statusCode, 404);
  const currentLookup = await app.inject({
    method: "GET",
    url: `/board-invitations/lookup?token=${encodeURIComponent(secondInviteBody.token!)}`,
  });
  assert.equal(currentLookup.statusCode, 200);

  const inviteRows = await db.select().from(boardInvitations).where(eq(boardInvitations.email, "bundled-guest@external.test"));
  assert.equal(inviteRows.length, 1);
  const grantRows = await db.select().from(boardInvitationGrants).where(eq(boardInvitationGrants.invitationId, inviteRows[0]!.id));
  assert.deepEqual(grantRows.map((grant) => grant.boardId).sort(), workspaceBoards.map((board) => board.id).sort());

  const duplicate = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/guests/invitations`,
    headers: { authorization: `Bearer ${hostToken}` },
    payload: { boardId: workspaceBoards[1]!.id, email: "bundled-guest@external.test", role: "editor" },
  });
  assert.equal(duplicate.statusCode, 409);
  const inviteEmails = await db.select().from(emailQueue).where(eq(emailQueue.type, "board_invite"));
  assert.equal(inviteEmails.length, 2);
  assert.deepEqual(inviteEmails.map((row) => row.data), [
    {
      boards: [{ boardName: "Board A", role: "observer" }],
      orgName: "Bundled Guest Host",
      invitedByName: "Host Owner",
      acceptUrl: `${env.WEB_ORIGIN}/board-invite?token=${encodeURIComponent(firstInviteBody.token!)}`,
    },
    {
      boards: [
        { boardName: "Board A", role: "observer" },
        { boardName: "Board B", role: "editor" },
      ],
      orgName: "Bundled Guest Host",
      invitedByName: "Host Owner",
      acceptUrl: `${env.WEB_ORIGIN}/board-invite?token=${encodeURIComponent(secondInviteBody.token!)}`,
    },
  ]);

  const pending = await app.inject({
    method: "GET",
    url: `/workspaces/${workspace.id}/guests`,
    headers: { authorization: `Bearer ${hostToken}` },
  });
  assert.equal(pending.statusCode, 200);
  const pendingBody = pending.json<WorkspaceGuestsResponse>();
  assert.equal(pendingBody.pendingInvites?.length, 1);
  assert.equal(pendingBody.pendingInvites?.[0]?.boards?.length, 2);

  const guestSignup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Bundled Guest External",
      email: "bundled-guest@external.test",
      password: "Abc12345",
      displayName: "Bundled Guest",
    },
  });
  assert.equal(guestSignup.statusCode, 200);
  const { accessToken: guestToken, user: guest } = guestSignup.json<SignupResponse>();

  const accept = await app.inject({
    method: "POST",
    url: `/board-invitations/${firstInviteBody.invite!.id}/accept`,
    headers: { authorization: `Bearer ${guestToken}` },
  });
  assert.equal(accept.statusCode, 200, accept.body);

  const memberships = await db.select().from(boardMembers).where(eq(boardMembers.userId, guest.id));
  assert.deepEqual(memberships.map((member) => [member.boardId, member.role]).sort(), [
    [workspaceBoards[0]!.id, "observer"],
    [workspaceBoards[1]!.id, "editor"],
  ].sort());
});

void test("workspace guest management emails an existing external user for every newly granted board", async () => {
  const app = await buildIntegrationServer();

  const hostSignup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Existing Guest Host",
      email: "existing-guest-host@example.com",
      password: "Abc12345",
      displayName: "Host Owner",
    },
  });
  assert.equal(hostSignup.statusCode, 200);
  const { accessToken: hostToken } = hostSignup.json<SignupResponse>();

  const workspaceResponse = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${hostToken}` },
    payload: { name: "Host Workspace" },
  });
  assert.equal(workspaceResponse.statusCode, 201);
  const workspace = workspaceResponse.json<WorkspaceResponse>();
  const workspaceBoards = await db
    .insert(boards)
    .values([
      { workspaceId: workspace.id, name: "First Guest Board", position: "1000.0000000000" },
      { workspaceId: workspace.id, name: "Second Guest Board", position: "2000.0000000000" },
    ])
    .returning();

  const guestSignup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Existing Guest Org",
      email: "existing-guest@external.test",
      password: "Abc12345",
      displayName: "Existing Guest",
    },
  });
  assert.equal(guestSignup.statusCode, 200);

  for (const [index, board] of workspaceBoards.entries()) {
    const add = await app.inject({
      method: "POST",
      url: `/workspaces/${workspace.id}/guests/invitations`,
      headers: { authorization: `Bearer ${hostToken}` },
      payload: { boardId: board.id, email: "existing-guest@external.test", role: index === 0 ? "observer" : "editor" },
    });
    assert.equal(add.statusCode, 201, add.body);
    assert.equal(add.json<GuestInviteResponse>().status, "added");
  }

  const accessEmails = await db
    .select()
    .from(emailQueue)
    .where(eq(emailQueue.type, "board_access_granted"));
  assert.equal(accessEmails.length, 2);
  assert.deepEqual(accessEmails.map((row) => row.data), [
    {
      displayName: "Existing Guest",
      boardName: "First Guest Board",
      orgName: "Existing Guest Host",
      invitedByName: "Host Owner",
      role: "observer",
      boardUrl: `${env.WEB_ORIGIN}/b/${workspaceBoards[0]!.id}`,
    },
    {
      displayName: "Existing Guest",
      boardName: "Second Guest Board",
      orgName: "Existing Guest Host",
      invitedByName: "Host Owner",
      role: "editor",
      boardUrl: `${env.WEB_ORIGIN}/b/${workspaceBoards[1]!.id}`,
    },
  ]);

  const duplicate = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/guests/invitations`,
    headers: { authorization: `Bearer ${hostToken}` },
    payload: { boardId: workspaceBoards[1]!.id, email: "existing-guest@external.test", role: "observer" },
  });
  assert.equal(duplicate.statusCode, 409);
  assert.equal(await db.$count(emailQueue, eq(emailQueue.type, "board_access_granted")), 2);
});

void test("workspace guest management limits one external guest to two accepted boards in the host org", async () => {
  const previousMode = env.KANERA_DEPLOYMENT_MODE;
  const previousStripeSecret = env.STRIPE_SECRET_KEY;
  env.KANERA_DEPLOYMENT_MODE = "hosted";
  env.STRIPE_SECRET_KEY = "sk_test_fake";
  const app = await buildIntegrationServer();
  try {

  const hostSignup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Guest Limit Host",
      email: "guest-limit-owner@example.com",
      password: "Abc12345",
      displayName: "Host Owner",
    },
  });
  assert.equal(hostSignup.statusCode, 200);
  const { accessToken: hostToken } = hostSignup.json<SignupResponse>();

  const created = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${hostToken}` },
    payload: { name: "Limited Workspace" },
  });
  assert.equal(created.statusCode, 201);
  const workspace = created.json<WorkspaceResponse>();
  // Host org is active with a purchased pool of exactly 1 seat (the owner), so the pool is full.
  await db
    .update(clients)
    .set({ billingStatus: "active", stripeSubscriptionItemId: "si_guest_limit", seatLimit: 1 })
    .where(eq(clients.id, workspace.clientId));
  // Guest assignment/removal must never touch Stripe under the pre-purchased pool model — capacity is
  // bought separately via setSeatCapacity. Any call here is a regression.
  setStripeClientForTests({
    subscriptionItems: {
      retrieve: async () => { throw new Error("Stripe should not be called during guest assignment"); },
      update: async () => { throw new Error("Stripe should not be called during guest assignment"); },
    },
  } as unknown as Stripe);

  const workspaceBoards = await db
    .insert(boards)
    .values([
      { workspaceId: workspace.id, name: "Guest One", position: "1000.0000000000" },
      { workspaceId: workspace.id, name: "Guest Two", position: "2000.0000000000" },
      { workspaceId: workspace.id, name: "Guest Three", position: "3000.0000000000" },
      { workspaceId: workspace.id, name: "Guest Four", position: "4000.0000000000" },
    ])
    .returning();
  assert.equal(workspaceBoards.length, 4);

  const externalSignup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Guest Limit External",
      email: "guest-limit-external@external.test",
      password: "Abc12345",
      displayName: "External Guest",
    },
  });
  assert.equal(externalSignup.statusCode, 200);
  const { user: externalUser } = externalSignup.json<SignupResponse>();

  await db.insert(boardMembers).values([
    { boardId: workspaceBoards[0]!.id, userId: externalUser.id, role: "editor" },
    { boardId: workspaceBoards[1]!.id, userId: externalUser.id, role: "observer" },
  ]);

  // Free cap is 2 boards. Adding a 3rd crosses it and needs a pool seat, but the pool is full (1/1) →
  // block-until-buy 402 SEAT_LIMIT_REACHED, and nothing is assigned.
  const poolFull = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/guests/invitations`,
    headers: { authorization: `Bearer ${hostToken}` },
    payload: { boardId: workspaceBoards[2]!.id, email: "guest-limit-external@external.test", role: "editor" },
  });
  assert.equal(poolFull.statusCode, 402);
  assert.equal(poolFull.json<{ code: string }>().code, "SEAT_LIMIT_REACHED");
  assert.equal(await db.$count(clientGuestSeats, and(eq(clientGuestSeats.clientId, workspace.clientId), eq(clientGuestSeats.userId, externalUser.id))), 0);
  assert.equal(await db.$count(boardMembers, eq(boardMembers.userId, externalUser.id)), 2);

  // Admin buys another seat (capacity 1 → 2). Now there is room for the guest's pooled seat. Simulated
  // with a direct seat_limit bump (the buy flow itself is covered by the billing tests).
  await db.update(clients).set({ seatLimit: 2 }).where(eq(clients.id, workspace.clientId));

  const thirdBoard = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/guests/invitations`,
    headers: { authorization: `Bearer ${hostToken}` },
    payload: { boardId: workspaceBoards[2]!.id, email: "guest-limit-external@external.test", role: "editor" },
  });
  assert.equal(thirdBoard.statusCode, 201);
  const thirdBody = thirdBoard.json<{ status: string; guest?: { paidGuestSeat?: boolean } }>();
  assert.equal(thirdBody.status, "added");
  assert.equal(thirdBody.guest?.paidGuestSeat, true);
  assert.equal(await db.$count(clientGuestSeats, and(eq(clientGuestSeats.clientId, workspace.clientId), eq(clientGuestSeats.userId, externalUser.id))), 1);
  assert.equal(await db.$count(boardMembers, eq(boardMembers.userId, externalUser.id)), 3);

  const fourthBoard = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/guests/invitations`,
    headers: { authorization: `Bearer ${hostToken}` },
    payload: { boardId: workspaceBoards[3]!.id, email: "guest-limit-external@external.test", role: "observer" },
  });
  assert.equal(fourthBoard.statusCode, 201);
  assert.equal(await db.$count(clientGuestSeats, and(eq(clientGuestSeats.clientId, workspace.clientId), eq(clientGuestSeats.userId, externalUser.id))), 1);

  const removeFourth = await app.inject({
    method: "DELETE",
    url: `/workspaces/${workspace.id}/guests/${workspaceBoards[3]!.id}/${externalUser.id}`,
    headers: { authorization: `Bearer ${hostToken}` },
  });
  assert.equal(removeFourth.statusCode, 200);
  assert.equal(removeFourth.json<{ paidGuestSeatRemoved: boolean }>().paidGuestSeatRemoved, false);
  assert.equal(await db.$count(clientGuestSeats, and(eq(clientGuestSeats.clientId, workspace.clientId), eq(clientGuestSeats.userId, externalUser.id))), 1);

  const removeThird = await app.inject({
    method: "DELETE",
    url: `/workspaces/${workspace.id}/guests/${workspaceBoards[2]!.id}/${externalUser.id}`,
    headers: { authorization: `Bearer ${hostToken}` },
  });
  assert.equal(removeThird.statusCode, 200);
  assert.equal(removeThird.json<{ paidGuestSeatRemoved: boolean }>().paidGuestSeatRemoved, true);
  assert.equal(await db.$count(clientGuestSeats, and(eq(clientGuestSeats.clientId, workspace.clientId), eq(clientGuestSeats.userId, externalUser.id))), 0);

  const pendingOne = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/guests/invitations`,
    headers: { authorization: `Bearer ${hostToken}` },
    payload: { boardId: workspaceBoards[0]!.id, email: "pending-limit@external.test", role: "editor" },
  });
  assert.equal(pendingOne.statusCode, 201);

  const pendingTwo = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/guests/invitations`,
    headers: { authorization: `Bearer ${hostToken}` },
    payload: { boardId: workspaceBoards[1]!.id, email: "pending-limit@external.test", role: "observer" },
  });
  assert.equal(pendingTwo.statusCode, 201);

  const pendingThird = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/guests/invitations`,
    headers: { authorization: `Bearer ${hostToken}` },
    payload: { boardId: workspaceBoards[2]!.id, email: "pending-limit@external.test", role: "editor" },
  });
  assert.equal(pendingThird.statusCode, 201);
  } finally {
    env.KANERA_DEPLOYMENT_MODE = previousMode;
    env.STRIPE_SECRET_KEY = previousStripeSecret;
    setStripeClientForTests(null);
  }
});
