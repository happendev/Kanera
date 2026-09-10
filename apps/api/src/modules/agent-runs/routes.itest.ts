import "../../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTIVITY_ACTION, activityEvents, agentRuns, boards, cards, lists } from "@kanera/shared/schema";
import { and, eq } from "drizzle-orm";
import { db } from "../../db.js";
import { AGENT_RUN_STALL_AFTER_MS, sweepStalledAgentRuns } from "../../lib/agent-runs.js";
import { buildPublicApiServer } from "../../public-api-server.js";
import { signupOwner } from "../../test/api-fixtures.js";
import { buildIntegrationServer, testUploadsDir } from "../../test/integration.js";

interface RunRow {
  id: string;
  cardId: string;
  status: string;
  title: string;
  summary: string | null;
  externalUrl: string | null;
  agentName: string;
  agentGrantId: string | null;
  heartbeatAt: string;
  endedAt: string | null;
}

async function setup() {
  const app = await buildIntegrationServer();
  const owner = await signupOwner(app, { orgName: "Acme", email: "owner@example.com", displayName: "Owner" });
  const created = await app.inject({ method: "POST", url: "/workspaces", headers: owner.auth, payload: { name: "Delivery" } });
  assert.equal(created.statusCode, 201);
  const workspaceId = created.json<{ id: string }>().id;
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspaceId)).limit(1);
  assert.ok(list);
  const [board] = await db.insert(boards).values({ workspaceId, name: "Roadmap", position: "1000.0000000000" }).returning();
  assert.ok(board);
  const workspace = { id: workspaceId, boardId: board.id, listId: list.id };
  const [card] = await db.insert(cards).values({
    listId: workspace.listId,
    boardId: workspace.boardId,
    title: "Agent target",
    position: "1000.0000000000",
    createdById: owner.user.id,
  }).returning();
  assert.ok(card);
  return { app, owner, workspace, card };
}

async function cardActivity(cardId: string, action: string) {
  return db.select().from(activityEvents)
    .where(and(eq(activityEvents.entityType, "card"), eq(activityEvents.entityId, cardId), eq(activityEvents.action, action)));
}

void test("agent runs: start, heartbeat, block, finish, and refuse edits after the end", async () => {
  const { app, owner, workspace, card } = await setup();

  const started = await app.inject({
    method: "POST",
    url: `/cards/${card.id}/agent-runs`,
    headers: owner.auth,
    payload: { title: "Drafting the launch copy", externalUrl: "https://example.test/session/1" },
  });
  assert.equal(started.statusCode, 201, started.body);
  const run = started.json<RunRow>();
  assert.equal(run.status, "running");
  assert.equal(run.cardId, card.id);
  // A browser session has no agent identity; the run is still labelled so the UI never shows a blank.
  assert.equal(run.agentName, "Manual run");
  assert.equal(run.agentGrantId, null);
  assert.equal((await cardActivity(card.id, ACTIVITY_ACTION.AGENT_RUN_STARTED)).length, 1);

  const boardLive = await app.inject({ method: "GET", url: `/boards/${workspace.boardId}/agent-runs`, headers: owner.auth });
  assert.equal(boardLive.statusCode, 200);
  assert.deepEqual(boardLive.json<{ runs: RunRow[] }>().runs.map((r) => r.id), [run.id]);

  // An empty PATCH is a heartbeat.
  await db.update(agentRuns).set({ heartbeatAt: new Date(Date.now() - 60_000) }).where(eq(agentRuns.id, run.id));
  const beat = await app.inject({ method: "PATCH", url: `/agent-runs/${run.id}`, headers: owner.auth, payload: {} });
  assert.equal(beat.statusCode, 200, beat.body);
  assert.ok(new Date(beat.json<RunRow>().heartbeatAt).getTime() > Date.now() - 5_000);
  assert.equal(beat.json<RunRow>().status, "running");

  const blocked = await app.inject({
    method: "PATCH", url: `/agent-runs/${run.id}`, headers: owner.auth,
    payload: { status: "blocked", summary: "Need a decision on the headline" },
  });
  assert.equal(blocked.statusCode, 200);
  assert.equal(blocked.json<RunRow>().status, "blocked");
  assert.equal(blocked.json<RunRow>().summary, "Need a decision on the headline");
  // Blocked runs are still live.
  const stillLive = await app.inject({ method: "GET", url: `/cards/${card.id}/agent-runs`, headers: owner.auth });
  assert.equal(stillLive.json<{ runs: RunRow[] }>().runs.length, 1);
  assert.equal((await cardActivity(card.id, ACTIVITY_ACTION.AGENT_RUN_ENDED)).length, 0);

  const finished = await app.inject({
    method: "PATCH", url: `/agent-runs/${run.id}`, headers: owner.auth,
    payload: { status: "succeeded", summary: "Posted the draft as a comment." },
  });
  assert.equal(finished.statusCode, 200);
  assert.equal(finished.json<RunRow>().status, "succeeded");
  assert.ok(finished.json<RunRow>().endedAt);
  const ended = await cardActivity(card.id, ACTIVITY_ACTION.AGENT_RUN_ENDED);
  assert.equal(ended.length, 1);
  assert.equal((ended[0]!.payload as { status: string }).status, "succeeded");

  const liveAfter = await app.inject({ method: "GET", url: `/cards/${card.id}/agent-runs`, headers: owner.auth });
  assert.equal(liveAfter.json<{ runs: RunRow[] }>().runs.length, 0, "ended runs are excluded by default");
  const history = await app.inject({ method: "GET", url: `/cards/${card.id}/agent-runs?includeEnded=true`, headers: owner.auth });
  assert.equal(history.json<{ runs: RunRow[] }>().runs.length, 1);

  // Ended runs are immutable history.
  const reopen = await app.inject({ method: "PATCH", url: `/agent-runs/${run.id}`, headers: owner.auth, payload: { status: "running" } });
  assert.equal(reopen.statusCode, 409);
});

void test("agent runs through the public API are labelled by the credential and stall without heartbeats", async () => {
  const { app, owner, workspace, card } = await setup();
  const key = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/api-keys`,
    headers: owner.auth,
    payload: { name: "Deploy bot", scope: "write" },
  });
  assert.equal(key.statusCode, 201, key.body);
  const secret = key.json<{ secret: string }>().secret;

  const publicApi = await buildPublicApiServer({ logger: false, uploadsDir: testUploadsDir("test-agent-run-uploads"), rateLimit: { enabled: false } });
  try {
    const started = await publicApi.inject({
      method: "POST",
      url: `/api/v1/cards/${card.id}/agent-runs`,
      headers: { authorization: `Bearer ${secret}` },
      payload: { title: "Rolling out v2" },
    });
    assert.equal(started.statusCode, 201, started.body);
    const run = started.json<RunRow>();
    assert.equal(run.agentName, "Deploy bot");
    const [startedActivity] = await cardActivity(card.id, ACTIVITY_ACTION.AGENT_RUN_STARTED);
    assert.equal(startedActivity?.actorKind, "apiKey");

    // A fresh run is not stalled; one whose heartbeat lapsed is, and the stall is recorded as system
    // activity (nobody acted) while the run stays open for the agent to close properly.
    assert.equal(await sweepStalledAgentRuns(), 0);
    await db.update(agentRuns)
      .set({ heartbeatAt: new Date(Date.now() - AGENT_RUN_STALL_AFTER_MS - 1_000) })
      .where(eq(agentRuns.id, run.id));
    assert.equal(await sweepStalledAgentRuns(), 1);
    const [stalled] = await db.select().from(agentRuns).where(eq(agentRuns.id, run.id));
    assert.equal(stalled?.status, "stalled");
    assert.equal(stalled?.endedAt, null);
    const ended = await cardActivity(card.id, ACTIVITY_ACTION.AGENT_RUN_ENDED);
    assert.equal(ended.length, 1);
    assert.equal(ended[0]!.actorKind, "system");
    assert.equal((ended[0]!.payload as { status: string; agentName: string }).agentName, "Deploy bot");

    const closed = await publicApi.inject({
      method: "PATCH",
      url: `/api/v1/agent-runs/${run.id}`,
      headers: { authorization: `Bearer ${secret}` },
      payload: { status: "failed", summary: "Runner lost network." },
    });
    assert.equal(closed.statusCode, 200, closed.body);
    assert.equal(closed.json<RunRow>().status, "failed");
    assert.ok(closed.json<RunRow>().endedAt);
  } finally {
    await publicApi.close();
  }
});

void test("agent runs require editor access on the card's board", async () => {
  const { app, card } = await setup();
  const other = await buildIntegrationServer();
  const outsider = await signupOwner(other, { orgName: "Other", email: "outsider@example.com", displayName: "Outsider" });
  const denied = await app.inject({
    method: "POST",
    url: `/cards/${card.id}/agent-runs`,
    headers: outsider.auth,
    payload: { title: "Sneaky" },
  });
  assert.ok(denied.statusCode === 403 || denied.statusCode === 404, `expected access denial, got ${denied.statusCode}`);
});
