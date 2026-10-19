import "../../test/setup.integration.js";
import { boardMembers, boards, cardCustomFieldValues, cards, customFields, lists, workspaceApiKeys, workspaceMembers } from "@kanera/shared/schema";
import type { DependencyGraphResponse } from "@kanera/shared/dto";
import { asc, eq } from "drizzle-orm";
import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../../db.js";
import { hashOpaqueToken } from "../../lib/tokens.js";
import { buildPublicApiServer } from "../../public-api-server.js";
import { buildIntegrationServer } from "../../test/integration.js";
import { signupOwner } from "../../test/api-fixtures.js";
import { insertTestUsers } from "../../test/user-fixtures.js";

/**
 * Failure modes these cover, which the E2E suite cannot pin down card by card:
 * - a card on a board the viewer cannot open appears on the map (title, board, assignees leak), or
 *   the walk steps through it and surfaces the chain behind it;
 * - the walk follows a chain through completed cards and drags the workspace's history onto the map;
 * - a board-scoped map stops at the board edge and loses the cross-board blocker that holds it up;
 * - tiles show fields a board card hides (`showOnCard` off), or the payload carries every field value;
 * - the map offers to add or remove dependencies on a board the viewer only observes;
 * - the public API copy of the route lets a credential see further than its owner, or lets a
 *   workspace key read a map in a workspace it is not pinned to.
 */
void test("dependency map follows open chains across boards, stops at completed cards and hides private ones", async () => {
  const app = await buildIntegrationServer();
  try {
    const owner = await signupOwner(app, { orgName: "Acme dependency map", email: "owner-dependency-map@example.com", displayName: "Owner" });
    const created = await app.inject({ method: "POST", url: "/workspaces", headers: owner.auth, payload: { name: "Delivery" } });
    assert.equal(created.statusCode, 201, created.body);
    const workspaceId = created.json<{ id: string }>().id;
    const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspaceId)).orderBy(asc(lists.position)).limit(1);
    assert.ok(list);
    const [shared, other, hidden] = await db.insert(boards).values([
      { workspaceId, name: "Shared", position: "1000.0000000000" },
      { workspaceId, name: "Other", position: "2000.0000000000" },
      { workspaceId, name: "Private", position: "3000.0000000000" },
    ]).returning();
    assert.ok(shared && other && hidden);
    const insertCard = async (boardId: string, title: string) => {
      const [card] = await db.insert(cards).values({ listId: list.id, boardId, title, position: "1000.0000000000", createdById: owner.user.id }).returning();
      assert.ok(card);
      return card;
    };
    const relate = async (cardId: string, targetCardId: string, direction: "blocks" | "relates_to") => {
      const response = await app.inject({ method: "POST", url: `/cards/${cardId}/relations`, headers: owner.auth, payload: { targetCardId, direction } });
      assert.equal(response.statusCode, 201, response.body);
    };

    // upstream (Other) → launch (Shared) → rollout (Shared); secret (Private) → launch;
    // secretParent (Private) → secret; history (done, Other) → upstream is walked no further.
    const ancient = await insertCard(other.id, "Ancient prerequisite");
    const history = await insertCard(other.id, "Done groundwork");
    const upstream = await insertCard(other.id, "Upstream API");
    const launch = await insertCard(shared.id, "Launch");
    const rollout = await insertCard(shared.id, "Rollout");
    const secretParent = await insertCard(hidden.id, "Secret parent");
    const secret = await insertCard(hidden.id, "Secret migration");
    const related = await insertCard(other.id, "Related research");
    const unrelated = await insertCard(shared.id, "No relations");
    await relate(ancient.id, history.id, "blocks");
    await relate(history.id, upstream.id, "blocks");
    await relate(upstream.id, launch.id, "blocks");
    await relate(launch.id, rollout.id, "blocks");
    await relate(secretParent.id, secret.id, "blocks");
    await relate(secret.id, launch.id, "blocks");
    await relate(launch.id, related.id, "relates_to");
    // Completing after relating: a completed card cannot become a blocker, but can stop being open.
    await db.update(cards).set({ completedAt: new Date() }).where(eq(cards.id, history.id));
    await db.update(cards).set({ completedAt: new Date() }).where(eq(cards.id, ancient.id));
    const [shownField, hiddenField] = await db.insert(customFields).values([
      { workspaceId, name: "Estimate", type: "number", position: "9000.0000000000", showOnCard: true },
      { workspaceId, name: "Internal notes", type: "text", position: "9100.0000000000", showOnCard: false },
    ]).returning();
    assert.ok(shownField && hiddenField);
    await db.insert(cardCustomFieldValues).values([
      { cardId: launch.id, fieldId: shownField.id, valueNumber: "5" },
      { cardId: launch.id, fieldId: hiddenField.id, valueText: "Only in card detail" },
    ]);

    const [member] = await insertTestUsers(db, { clientId: owner.user.clientId, email: "member-dependency-map@example.com", passwordHash: "x", displayName: "Member" }).returning();
    assert.ok(member);
    await db.insert(workspaceMembers).values({ workspaceId, userId: member.id, role: "member" });
    await db.insert(boardMembers).values([
      { boardId: shared.id, userId: member.id, role: "editor" as const },
      { boardId: other.id, userId: member.id, role: "observer" as const },
    ]);
    const memberAuth = { authorization: `Bearer ${app.jwt.sign({ sub: member.id, cid: owner.user.clientId, role: "member" })}` };

    const read = async (payload: object) => {
      const response = await app.inject({ method: "POST", url: "/cards/dependency-graph", headers: memberAuth, payload });
      assert.equal(response.statusCode, 200, response.body);
      return response.json<DependencyGraphResponse>();
    };

    const board = await read({ boardId: shared.id });
    const titles = new Set(board.cards.map((card) => card.title));
    assert.deepEqual([...titles].sort(), ["Done groundwork", "Launch", "Related research", "Rollout", "Upstream API"]);
    assert.ok(!board.cards.some((card) => card.boardId === hidden.id), "private cards stay off the map");
    assert.ok(!titles.has("Ancient prerequisite"), "the walk stops at a completed card");
    assert.ok(!titles.has("No relations"));
    assert.deepEqual(board.cards.filter((card) => card.inScope).map((card) => card.title).sort(), ["Launch", "Rollout"]);
    assert.equal(board.cards.find((card) => card.id === launch.id)?.blockedByCount, 2, "the private blocker is still counted");
    assert.ok(board.edges.every((edge) => edge.sourceCardId !== secret.id && edge.targetCardId !== secret.id));
    assert.equal(board.edges.length, 4);
    assert.deepEqual(board.boards.map((entry) => entry.name).sort(), ["Other", "Shared"]);
    assert.deepEqual(board.boards.filter((entry) => entry.canEdit).map((entry) => entry.name), ["Shared"], "an observer is not offered edits on the board they only watch");
    assert.equal(board.truncated, false);
    assert.ok(board.customFields.some((field) => field.id === shownField.id), "card-face fields come with the map");
    assert.ok(!board.customFields.some((field) => field.id === hiddenField.id), "fields hidden from cards stay off the map");
    assert.deepEqual(board.cards.find((card) => card.id === launch.id)?.customFieldValues?.map((value) => value.fieldId), [shownField.id]);

    const workspace = await read({ workspaceId });
    assert.ok(!workspace.cards.some((card) => card.boardId === hidden.id));
    assert.ok(workspace.cards.some((card) => card.id === upstream.id && card.inScope));

    const loaded = await read({ cardIds: [rollout.id, unrelated.id] });
    assert.deepEqual(loaded.cards.filter((card) => card.inScope).map((card) => card.id), [rollout.id]);
    assert.ok(loaded.cards.some((card) => card.id === upstream.id), "the chain is walked from a loaded card");

    const owners = await app.inject({ method: "POST", url: "/cards/dependency-graph", headers: owner.auth, payload: { boardId: shared.id } });
    assert.ok(owners.json<DependencyGraphResponse>().cards.some((card) => card.id === secretParent.id), "a viewer who can open the private board sees through it");

    const denied = await app.inject({ method: "POST", url: "/cards/dependency-graph", headers: memberAuth, payload: { boardId: hidden.id } });
    assert.equal(denied.statusCode, 403, "a board the viewer is not on is refused like every other board read");

    // Public API: the same walk, as the credential's owner may see it.
    const elsewhere = await app.inject({ method: "POST", url: "/workspaces", headers: owner.auth, payload: { name: "Elsewhere" } });
    assert.equal(elsewhere.statusCode, 201, elsewhere.body);
    const personalKey = "kanera_u_dependency_map_member";
    const pinnedKey = "kanera_w_dependency_map_elsewhere";
    await db.insert(workspaceApiKeys).values([
      { kind: "personal", clientId: owner.user.clientId, createdById: member.id, keyPrefix: "kanera_u_dm", keyHash: hashOpaqueToken(personalKey), scope: "read" },
      { kind: "workspace", workspaceId: elsewhere.json<{ id: string }>().id, createdById: owner.user.id, name: "Elsewhere", keyPrefix: "kanera_w_dm", keyHash: hashOpaqueToken(pinnedKey), scope: "read" },
    ]);
    const publicApi = await buildPublicApiServer({ enableWebhookDeliveryScheduler: false });
    try {
      const publicRead = (key: string, payload: object) => publicApi.inject({ method: "POST", url: "/api/v1/cards/dependency-graph", headers: { authorization: `Bearer ${key}` }, payload });
      const viaKey = await publicRead(personalKey, { boardId: shared.id });
      assert.equal(viaKey.statusCode, 200, viaKey.body);
      const keyMap = viaKey.json<DependencyGraphResponse>();
      assert.deepEqual(keyMap.cards.map((card) => card.id).sort(), board.cards.map((card) => card.id).sort(), "a read-only personal key sees exactly its owner's map");
      assert.ok(!keyMap.cards.some((card) => card.boardId === hidden.id));
      assert.equal(keyMap.cards.find((card) => card.id === launch.id)?.blockedByCount, 2);
      assert.ok(keyMap.boards.every((entry) => !entry.canEdit), "a read-only key is never offered edits");
      assert.match(keyMap.cards.find((card) => card.id === launch.id)?.url ?? "", /\/o\/[^/]+\/c\/[A-Z0-9]+-\d+$/u);

      const pinnedBoard = await publicRead(pinnedKey, { boardId: shared.id });
      assert.equal(pinnedBoard.statusCode, 403, "a workspace key cannot open a board outside its workspace");
      for (const payload of [{ workspaceId }, { cardIds: [launch.id] }]) {
        const pinned = await publicRead(pinnedKey, payload);
        assert.equal(pinned.statusCode, 200, pinned.body);
        assert.deepEqual(pinned.json<DependencyGraphResponse>().cards, [], "a workspace key reads nothing in another workspace");
      }
    } finally {
      await publicApi.close();
    }
  } finally {
    await app.close();
  }
});
