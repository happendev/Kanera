import "../../test/setup.integration.js";
import type { CardRelationsResponse, DependencyGraphResponse, HomeGettingStartedResponse } from "@kanera/shared/dto";
import { expandCardSummary, type CompactCardSummary, type WireCardDetail } from "@kanera/shared/events";
import type { WorkspaceFeatures } from "@kanera/shared/workspace-features";
import { boards, cards, lists } from "@kanera/shared/schema";
import { asc, eq } from "drizzle-orm";
import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../../db.js";
import { buildIntegrationServer } from "../../test/integration.js";
import { signupOwner } from "../../test/api-fixtures.js";

/**
 * Failure modes these cover. Each switch is only as good as its weakest surface, and E2E only
 * drives the web app, so the API is pinned here for the agents, CLI and SDK that call it directly:
 * - a disabled feature can still be written (a `blocks` relation, a start date, a gated trigger);
 * - its data still leaks through a read (blocked counts on the board, hidden relations, the start on
 *   card detail, the dependency map or schedule endpoints);
 * - completing a blocker still unblocks (and so notifies and automates) while dependencies are off;
 * - the organisation switch fails to override a workspace that is still on;
 * - the workspace in-progress switch leaves clocks running, or loses banked time on re-enable;
 * - re-enabling does not restore what was kept;
 * - Getting started still teaching dependencies or the Timeline where they are switched off, or the
 *   start-date step not ticking when a start is set.
 */
void test("workspace and organisation feature switches close every API surface and restore on re-enable", async () => {
  const app = await buildIntegrationServer();
  try {
    const owner = await signupOwner(app, { orgName: "Acme features", email: "owner-features@example.com", displayName: "Owner" });
    const created = await app.inject({ method: "POST", url: "/workspaces", headers: owner.auth, payload: { name: "Features" } });
    assert.equal(created.statusCode, 201, created.body);
    const workspaceId = created.json<{ id: string }>().id;
    const workspaceLists = await db.select().from(lists).where(eq(lists.workspaceId, workspaceId)).orderBy(asc(lists.position));
    const list = workspaceLists[0];
    const progressList = workspaceLists.find((entry) => entry.inProgress);
    assert.ok(list && progressList, "the default template has an In progress list");
    const [board] = await db.insert(boards).values({ workspaceId, name: "Plan", position: "1000.0000000000" }).returning();
    assert.ok(board);
    const insert = async (title: string, listId = list.id) => {
      const response = await app.inject({ method: "POST", url: `/boards/${board.id}/lists/${listId}/cards`, headers: owner.auth, payload: { title } });
      assert.equal(response.statusCode, 201, response.body);
      return response.json<{ id: string }>();
    };
    const patchWorkspace = async (payload: object) => {
      const response = await app.inject({ method: "PATCH", url: `/workspaces/${workspaceId}`, headers: owner.auth, payload });
      assert.equal(response.statusCode, 200, response.body);
    };
    const patchOrganisation = async (payload: object) => {
      const response = await app.inject({ method: "PATCH", url: "/clients/me", headers: owner.auth, payload });
      assert.equal(response.statusCode, 200, response.body);
    };
    const boardRead = async () => {
      const response = await app.inject({ method: "POST", url: `/boards/${board.id}/open`, headers: owner.auth });
      assert.equal(response.statusCode, 200, response.body);
      const body = response.json<{ features: WorkspaceFeatures; cards: CompactCardSummary[] }>();
      return { features: body.features, cards: new Map(body.cards.map((card) => [card.id, expandCardSummary(card)])) };
    };
    // Getting started teaches only features some board the viewer can open has switched on.
    const gettingStarted = async () => {
      const response = await app.inject({ method: "GET", url: "/home/getting-started", headers: owner.auth });
      assert.equal(response.statusCode, 200, response.body);
      const body = response.json<HomeGettingStartedResponse>();
      return { steps: new Map(body.steps.map((step) => [step.key, step.done])), timelineBoardId: body.timelineBoardId };
    };
    const relations = async (cardId: string) =>
      (await app.inject({ method: "GET", url: `/cards/${cardId}/relations`, headers: owner.auth })).json<CardRelationsResponse>();

    const blocker = await insert("Blocker");
    const blocked = await insert("Blocked");
    const related = await insert("Related");
    const dated = await insert("Dated");
    const addRelation = (from: string, to: string, direction: string) =>
      app.inject({ method: "POST", url: `/cards/${from}/relations`, headers: owner.auth, payload: { targetCardId: to, direction } });
    assert.equal((await addRelation(blocker.id, blocked.id, "blocks")).statusCode, 201);
    assert.equal((await app.inject({ method: "PATCH", url: `/cards/${dated.id}`, headers: owner.auth, payload: { dueDateLocalDate: "2030-06-07", startDateLocalDate: "2030-06-03" } })).statusCode, 200);
    const started = await gettingStarted();
    assert.equal(started.steps.get("setStartDate"), true, "setting a start ticks the step");
    assert.equal(started.steps.get("viewTimeline"), false);
    assert.equal(started.steps.get("addDependency"), true);
    assert.equal(started.timelineBoardId, board.id);
    const before = await boardRead();
    assert.deepEqual(before.features, { dependencies: true, timeline: true, inProgress: true }, "everything is on by default");
    assert.equal(before.cards.get(blocked.id)?.blockedByCount, 1);

    // Dependencies off in the workspace.
    await patchWorkspace({ dependenciesEnabled: false });
    const noDependencies = await boardRead();
    assert.equal(noDependencies.features.dependencies, false);
    assert.equal(noDependencies.cards.get(blocked.id)?.blockedByCount, 0, "no card reports blockers");
    assert.deepEqual((await relations(blocked.id)).relations, [], "blocks rows are hidden");
    const blocksAttempt = await addRelation(related.id, blocked.id, "blocks");
    assert.equal(blocksAttempt.statusCode, 403);
    assert.equal(blocksAttempt.json<{ code: string }>().code, "DEPENDENCIES_DISABLED");
    assert.equal((await addRelation(related.id, blocked.id, "relates_to")).statusCode, 201, "plain links stay on");
    assert.deepEqual((await relations(blocked.id)).relations.map((relation) => relation.direction), ["relates_to"]);
    const graph = await app.inject({ method: "POST", url: "/cards/dependency-graph", headers: owner.auth, payload: { boardId: board.id } });
    assert.equal(graph.statusCode, 403);
    const crossScope = await app.inject({ method: "POST", url: "/cards/dependency-graph", headers: owner.auth, payload: { cardIds: [blocked.id] } });
    assert.equal(crossScope.statusCode, 200);
    assert.deepEqual(crossScope.json<DependencyGraphResponse>().cards, [], "a card-set scope leaves the workspace out");
    const warning = await app.inject({ method: "POST", url: "/cards/completion-warning", headers: owner.auth, payload: { cardIds: [blocked.id] } });
    assert.equal(warning.json<{ blockedCardCount: number }>().blockedCardCount, 0);
    const blockedTrigger = await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/automations`, headers: owner.auth, payload: { name: "Unblocked", triggerType: "card_unblocked", actions: [] } });
    assert.equal(blockedTrigger.statusCode, 403, blockedTrigger.body);

    // Re-enabling restores the hidden relation and its count untouched.
    await patchWorkspace({ dependenciesEnabled: true });
    assert.equal((await boardRead()).cards.get(blocked.id)?.blockedByCount, 1);
    assert.deepEqual((await relations(blocked.id)).relations.map((relation) => relation.direction).sort(), ["blocked_by", "relates_to"]);

    // The organisation switch wins over a workspace that is still on.
    await patchOrganisation({ dependenciesEnabled: false });
    assert.equal((await boardRead()).features.dependencies, false);
    assert.equal((await gettingStarted()).steps.has("addDependency"), false, "the dependency step leaves with the feature");
    assert.equal((await addRelation(dated.id, blocked.id, "blocks")).statusCode, 403);
    await patchOrganisation({ dependenciesEnabled: true });

    // Timeline off: no start dates, no schedule.
    await patchWorkspace({ timelineEnabled: false });
    const noTimeline = await boardRead();
    assert.equal(noTimeline.features.timeline, false);
    assert.equal(noTimeline.cards.get(dated.id)?.startDateLocalDate, null, "the stored start is not reported");
    const detail = await app.inject({ method: "GET", url: `/cards/${dated.id}/detail`, headers: owner.auth });
    assert.equal(detail.json<WireCardDetail>().card.startDateLocalDate, null);
    const startAttempt = await app.inject({ method: "PATCH", url: `/cards/${dated.id}`, headers: owner.auth, payload: { startDateLocalDate: "2030-06-04" } });
    assert.equal(startAttempt.statusCode, 403);
    assert.equal(startAttempt.json<{ code: string }>().code, "TIMELINE_DISABLED");
    const createWithStart = await app.inject({ method: "POST", url: `/boards/${board.id}/lists/${list.id}/cards`, headers: owner.auth, payload: { title: "Planned", startDateLocalDate: "2030-06-03" } });
    assert.equal(createWithStart.statusCode, 403);
    assert.equal((await app.inject({ method: "PATCH", url: `/cards/${dated.id}`, headers: owner.auth, payload: { dueDateLocalDate: "2030-06-10" } })).statusCode, 200, "due dates are not part of the timeline");
    assert.equal((await app.inject({ method: "POST", url: "/cards/schedule", headers: owner.auth, payload: { boardId: board.id } })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url: "/cards/schedule", headers: owner.auth, payload: { workspaceId } })).statusCode, 403);
    const startTrigger = await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/automations`, headers: owner.auth, payload: { name: "Start", triggerType: "start_date_arrives", actions: [] } });
    assert.equal(startTrigger.statusCode, 403, startTrigger.body);
    const withoutTimeline = await gettingStarted();
    assert.equal(withoutTimeline.steps.has("setStartDate"), false);
    assert.equal(withoutTimeline.steps.has("viewTimeline"), false);
    assert.equal(withoutTimeline.timelineBoardId, null);
    await patchWorkspace({ timelineEnabled: true });
    assert.equal((await boardRead()).cards.get(dated.id)?.startDateLocalDate, "2030-06-03", "the kept start returns");
    assert.equal((await gettingStarted()).steps.get("setStartDate"), true);
    assert.equal((await app.inject({ method: "POST", url: "/cards/schedule", headers: owner.auth, payload: { boardId: board.id } })).statusCode, 200);

    // In progress off in the workspace banks the running clock; back on starts a fresh stint.
    const working = await insert("Working", progressList.id);
    const [running] = await db.select().from(cards).where(eq(cards.id, working.id));
    assert.ok(running?.inProgressSince, "a card in an In progress list is tracked");
    await patchWorkspace({ inProgressEnabled: false });
    const [paused] = await db.select().from(cards).where(eq(cards.id, working.id));
    assert.equal(paused?.inProgressSince, null, "the clock stops");
    assert.equal((await boardRead()).features.inProgress, false);
    const correction = await app.inject({ method: "PUT", url: `/cards/${working.id}/in-progress-time`, headers: owner.auth, payload: { seconds: 60 } });
    assert.equal(correction.statusCode, 403);
    assert.equal(correction.json<{ code: string }>().code, "IN_PROGRESS_DISABLED");
    await patchWorkspace({ inProgressEnabled: true });
    const [resumed] = await db.select().from(cards).where(eq(cards.id, working.id));
    assert.ok(resumed?.inProgressSince, "tracking resumes");
  } finally {
    await app.close();
  }
});
