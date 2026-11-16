import "../../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { activityEvents, automationRuns, cardLabelAssignments, cards, eventOutbox, notifications, workspaceAnalyticsMilestones } from "@kanera/shared/schema";
import { standaloneBoardCreatePayload, workspaceTemplateSeedPayload } from "@kanera/shared/workspace-template-payload";
import { WORKSPACE_TEMPLATES, type WorkspaceTemplateId } from "@kanera/shared/workspace-templates";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db.js";
import { signupOwner } from "../../test/api-fixtures.js";
import { buildIntegrationServer } from "../../test/integration.js";

// Onboarding sends a template's example cards so a new board is not empty. They are the template's
// work, not the person's: they must not tick the meaningful-work milestone (three real cards), and,
// being written inside the creation transaction, they reach nobody as notifications, automation runs
// or per-card realtime events.

const template = (id: WorkspaceTemplateId) => WORKSPACE_TEMPLATES.find((candidate) => candidate.id === id)!;

async function assertSeededAsTemplateContent(workspaceId: string, boardId: string, expectedTitles: string[]) {
  const seeded = await db.select().from(cards).where(eq(cards.boardId, boardId));
  assert.deepEqual(seeded.map((card) => card.title).sort(), [...expectedTitles].sort());

  const created = await db.select().from(activityEvents).where(and(
    eq(activityEvents.workspaceId, workspaceId),
    eq(activityEvents.entityType, "card"),
    eq(activityEvents.action, "created"),
  ));
  assert.equal(created.length, expectedTitles.length);
  for (const row of created) {
    assert.equal((row.payload as { seededFromWorkspaceTemplate?: boolean }).seededFromWorkspaceTemplate, true);
  }

  // More example cards than the meaningful-work threshold, and the milestone still has not started.
  assert.ok(expectedTitles.length >= 3);
  const [milestones] = await db.select().from(workspaceAnalyticsMilestones)
    .where(eq(workspaceAnalyticsMilestones.workspaceId, workspaceId));
  assert.ok(milestones, "creating the board evaluates the milestones");
  assert.equal(milestones.meaningfulWorkCreatedAt, null);

  const cardIds = seeded.map((card) => card.id);
  assert.equal(await db.$count(automationRuns, inArray(automationRuns.cardId, cardIds)), 0);
  assert.equal(await db.$count(notifications, inArray(notifications.cardId, cardIds)), 0);
  assert.equal(await db.$count(eventOutbox, and(eq(eventOutbox.boardId, boardId), eq(eventOutbox.eventType, "card:created"))), 0);
  return seeded;
}

void test("a standalone board from a template starts with its example cards, flagged as template content", async () => {
  const app = await buildIntegrationServer();
  const { auth } = await signupOwner(app, { orgName: "Solo Org", email: "template-seed-solo@example.com" });
  const development = template("development-team");

  const created = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: auth,
    payload: standaloneBoardCreatePayload("Engineering board", development),
  });
  assert.equal(created.statusCode, 201, created.body);
  const result = created.json<{ id: string; initialBoard: { id: string } }>();

  const seeded = await assertSeededAsTemplateContent(result.id, result.initialBoard.id, development.cards!.map((card) => card.title));
  const bug = seeded.find((card) => card.title === "Fix the login error on Safari")!;
  // Seeded cards skip the list entry rule, so the template gives the bug card the label it would add.
  assert.equal(await db.$count(cardLabelAssignments, eq(cardLabelAssignments.cardId, bug.id)), 1);
});

void test("a workspace from a template seeds its example cards on the initial board the same way", async () => {
  const app = await buildIntegrationServer();
  const { auth } = await signupOwner(app, { orgName: "Workspace Org", email: "template-seed-workspace@example.com" });
  const marketing = template("marketing");

  const created = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: auth,
    payload: {
      name: marketing.workspaceName,
      icon: marketing.icon,
      initialBoard: { name: marketing.initialBoardName, icon: marketing.icon },
      lists: marketing.lists,
      customFields: marketing.customFields,
      labels: marketing.labels,
      ...workspaceTemplateSeedPayload(marketing),
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  const result = created.json<{ id: string; initialBoard: { id: string } }>();

  await assertSeededAsTemplateContent(result.id, result.initialBoard.id, marketing.cards!.map((card) => card.title));
});
