import "../test/setup.integration.js";
import {
  automations,
  boardInvitationGrants,
  boardInvitations,
  boardMembers,
  boards,
  cardAssignees,
  cardChecklistItems,
  cardChecklists,
  cards,
  clientGuestSeats,
  clients,
  eventOutbox,
  lists,
  planActions,
  users,
  webhookEndpoints,
  workspaceApiKeys,
  workspaces,
} from "@kanera/shared/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { db } from "../db.js";
import { env } from "../env.js";
import { buildIntegrationServer } from "../test/integration.js";
import { convertClientPlan } from "./plan-conversion.js";

// Deterministic, increasing createdAt timestamps so "keep the oldest" selection is unambiguous.
const BASE = Date.UTC(2024, 0, 1, 0, 0, 0);
const at = (minutes: number) => new Date(BASE + minutes * 60_000);

async function insertClient(name: string): Promise<string> {
  const [row] = await db.insert(clients).values({ name, plan: "paid", billingStatus: "active" }).returning({ id: clients.id });
  return row!.id;
}

async function insertUser(clientId: string, role: "owner" | "admin" | "member", createdAt: Date): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({
      clientId,
      clientRole: role,
      email: `${role}-${randomUUID()}@example.com`,
      passwordHash: "x",
      displayName: role,
      createdAt,
    })
    .returning({ id: users.id });
  return row!.id;
}

async function insertWorkspace(clientId: string, name: string, createdAt: Date): Promise<string> {
  const [row] = await db.insert(workspaces).values({ clientId, name, createdAt }).returning({ id: workspaces.id });
  return row!.id;
}

async function insertBoard(workspaceId: string, name: string, createdAt: Date): Promise<string> {
  const [row] = await db.insert(boards).values({ workspaceId, name, position: "1", createdAt }).returning({ id: boards.id });
  return row!.id;
}

// Temporarily forces hosted mode plus tight free-tier caps so the fixtures stay small.
async function withFreeCaps<T>(caps: { boards: number; members: number; automations: number }, fn: () => Promise<T>): Promise<T> {
  const prev = {
    mode: env.KANERA_DEPLOYMENT_MODE,
    bd: env.HOSTED_FREE_MAX_BOARDS,
    mem: env.HOSTED_FREE_MAX_ORG_MEMBERS,
    au: env.HOSTED_FREE_MAX_ENABLED_AUTOMATIONS,
  };
  env.KANERA_DEPLOYMENT_MODE = "hosted";
  env.HOSTED_FREE_MAX_BOARDS = caps.boards;
  env.HOSTED_FREE_MAX_ORG_MEMBERS = caps.members;
  env.HOSTED_FREE_MAX_ENABLED_AUTOMATIONS = caps.automations;
  try {
    return await fn();
  } finally {
    env.KANERA_DEPLOYMENT_MODE = prev.mode;
    env.HOSTED_FREE_MAX_BOARDS = prev.bd;
    env.HOSTED_FREE_MAX_ORG_MEMBERS = prev.mem;
    env.HOSTED_FREE_MAX_ENABLED_AUTOMATIONS = prev.au;
  }
}

void test("downgrade to free disables over-limit resources; upgrade restores them", async () => {
  await withFreeCaps({ boards: 3, members: 2, automations: 1 }, async () => {
    // --- Seed a paid org well over every free cap. ---
    const clientId = await insertClient("Over Limit Org");
    const ownerId = await insertUser(clientId, "owner", at(0));
    await insertUser(clientId, "member", at(30)); // m1 (kept)
    await insertUser(clientId, "member", at(31)); // m2 (suspended)
    await insertUser(clientId, "member", at(32)); // m3 (suspended)

    const ws1 = await insertWorkspace(clientId, "Keep", at(1));
    const ws2 = await insertWorkspace(clientId, "Keep A", at(2));
    const ws3 = await insertWorkspace(clientId, "Keep B", at(3));

    const b1 = await insertBoard(ws1, "B1", at(10));
    await insertBoard(ws1, "B2", at(11));
    await insertBoard(ws1, "B3", at(12));
    await insertBoard(ws1, "B4", at(13)); // archived by org-wide board cap
    await insertBoard(ws2, "B5", at(14)); // archived by org-wide board cap
    await insertBoard(ws3, "B6", at(15)); // archived by org-wide board cap

    for (let i = 0; i < 3; i++) {
      await db.insert(automations).values({ workspaceId: ws1, enabled: true, position: "1", triggerType: "card_enters_list", createdAt: at(20 + i) });
    }
    for (let i = 0; i < 2; i++) {
      await db.insert(webhookEndpoints).values({ workspaceId: ws1, createdById: ownerId, name: `Hook ${i}`, url: "https://example.com/h", encryptedSecret: "s", enabled: true });
    }
    for (let i = 0; i < 2; i++) {
      await db.insert(workspaceApiKeys).values({ workspaceId: ws1, createdById: ownerId, name: `Key ${i}`, keyPrefix: "kan", keyHash: randomUUID(), scope: "read" });
    }
    // A personal key has no workspace, so it is located via its owner's client on downgrade/upgrade.
    const [personalKey] = await db
      .insert(workspaceApiKeys)
      .values({ kind: "personal", workspaceId: null, createdById: ownerId, name: null, keyPrefix: "kan", keyHash: randomUUID() })
      .returning({ id: workspaceApiKeys.id });

    // A cross-org guest member + a pending external guest invitation.
    const otherClientId = await insertClient("Guest Org");
    const guestUserId = await insertUser(otherClientId, "owner", at(0));
    await db.insert(boardMembers).values({ boardId: b1, userId: guestUserId, role: "editor" });
    await db.insert(clientGuestSeats).values({ clientId, userId: guestUserId, createdById: ownerId });
    const [list] = await db.insert(lists).values({ workspaceId: ws1, name: "Todo", position: "1000.0000000000" }).returning({ id: lists.id });
    const [card] = await db
      .insert(cards)
      .values({ boardId: b1, listId: list!.id, title: "Guest work", position: "1000.0000000000", createdById: ownerId })
      .returning({ id: cards.id });
    const [checklist] = await db
      .insert(cardChecklists)
      .values({ cardId: card!.id, title: "Steps", position: "1000.0000000000" })
      .returning({ id: cardChecklists.id });
    const [item] = await db
      .insert(cardChecklistItems)
      .values({ checklistId: checklist!.id, text: "Guest step", position: "1000.0000000000", assigneeId: guestUserId })
      .returning({ id: cardChecklistItems.id });
    await db.insert(cardAssignees).values({ cardId: card!.id, userId: guestUserId });
    const [invite] = await db
      .insert(boardInvitations)
      .values({ clientId, boardId: b1, email: `external-${randomUUID()}@ext.com`, tokenHash: randomUUID(), invitedById: ownerId, role: "editor" })
      .returning({ id: boardInvitations.id });
    await db.insert(boardInvitationGrants).values({ invitationId: invite!.id, boardId: b1, role: "editor" });

    // --- Downgrade ---
    await convertClientPlan(clientId, { plan: "free", billingStatus: "canceled" });

    assert.equal(await db.$count(workspaces, and(eq(workspaces.clientId, clientId), isNull(workspaces.archivedAt))), 3, "workspaces remain unlimited on free");
    const liveBoards = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(boards)
      .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
      .where(and(eq(workspaces.clientId, clientId), isNull(workspaces.archivedAt), isNull(boards.archivedAt)));
    assert.equal(liveBoards[0]!.c, 3, "three live boards");
    assert.equal(await db.$count(automations, and(eq(automations.workspaceId, ws1), eq(automations.enabled, true))), 1, "one enabled automation");
    assert.equal(await db.$count(webhookEndpoints, and(eq(webhookEndpoints.workspaceId, ws1), eq(webhookEndpoints.enabled, true))), 0, "no enabled webhooks");
    assert.equal(await db.$count(workspaceApiKeys, and(eq(workspaceApiKeys.workspaceId, ws1), isNull(workspaceApiKeys.revokedAt))), 0, "no active api keys");
    assert.equal(await db.$count(workspaceApiKeys, and(eq(workspaceApiKeys.id, personalKey!.id), isNull(workspaceApiKeys.revokedAt))), 0, "personal key revoked on downgrade");
    assert.equal(await db.$count(users, and(eq(users.clientId, clientId), isNull(users.suspendedAt))), 2, "two active members remain");
    const [owner] = await db.select({ suspendedAt: users.suspendedAt }).from(users).where(eq(users.id, ownerId));
    assert.equal(owner!.suspendedAt, null, "owner is never suspended");
    assert.equal(await db.$count(boardMembers, eq(boardMembers.userId, guestUserId)), 0, "guest membership removed");
    assert.equal(await db.$count(cardAssignees, and(eq(cardAssignees.cardId, card!.id), eq(cardAssignees.userId, guestUserId))), 0, "guest card assignment removed");
    const [updatedItem] = await db.select({ assigneeId: cardChecklistItems.assigneeId }).from(cardChecklistItems).where(eq(cardChecklistItems.id, item!.id)).limit(1);
    assert.equal(updatedItem?.assigneeId, null, "guest checklist assignment cleared");
    const cleanupEvents = await db
      .select({ eventType: eventOutbox.eventType })
      .from(eventOutbox)
      .where(and(eq(eventOutbox.boardId, b1), inArray(eventOutbox.eventType, ["board:member:removed", "card:assignees:set", "card:checklistItem:updated"])));
    assert.deepEqual(
      new Set(cleanupEvents.map((row) => row.eventType)),
      new Set(["board:member:removed", "card:assignees:set", "card:checklistItem:updated"]),
      "guest cleanup emits board/member and card assignment updates",
    );
    assert.equal(await db.$count(clientGuestSeats, and(eq(clientGuestSeats.clientId, clientId), eq(clientGuestSeats.userId, guestUserId))), 0, "paid guest seat removed");
    const [revoked] = await db.select({ revokedAt: boardInvitations.revokedAt }).from(boardInvitations).where(eq(boardInvitations.id, invite!.id));
    assert.notEqual(revoked!.revokedAt, null, "pending guest invite revoked");
    assert.ok((await db.$count(planActions, eq(planActions.clientId, clientId))) > 0, "plan actions recorded");

    // --- Upgrade restores everything the downgrade touched ---
    await convertClientPlan(clientId, { plan: "paid", billingStatus: "active" });

    assert.equal(await db.$count(workspaces, and(eq(workspaces.clientId, clientId), isNull(workspaces.archivedAt))), 3, "workspaces stayed live");
    const liveBoardsAfter = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(boards)
      .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
      .where(and(eq(workspaces.clientId, clientId), isNull(boards.archivedAt)));
    assert.equal(liveBoardsAfter[0]!.c, 6, "all boards live again");
    assert.equal(await db.$count(automations, and(eq(automations.workspaceId, ws1), eq(automations.enabled, true))), 3, "all automations re-enabled");
    assert.equal(await db.$count(webhookEndpoints, and(eq(webhookEndpoints.workspaceId, ws1), eq(webhookEndpoints.enabled, true))), 2, "webhooks re-enabled");
    assert.equal(await db.$count(workspaceApiKeys, and(eq(workspaceApiKeys.workspaceId, ws1), isNull(workspaceApiKeys.revokedAt))), 2, "api keys un-revoked");
    assert.equal(await db.$count(workspaceApiKeys, and(eq(workspaceApiKeys.id, personalKey!.id), isNull(workspaceApiKeys.revokedAt))), 1, "personal key un-revoked on upgrade");
    assert.equal(await db.$count(users, and(eq(users.clientId, clientId), isNull(users.suspendedAt))), 4, "all members active again");
    assert.equal(await db.$count(boardMembers, eq(boardMembers.userId, guestUserId)), 1, "guest membership re-inserted");
    assert.equal(await db.$count(clientGuestSeats, and(eq(clientGuestSeats.clientId, clientId), eq(clientGuestSeats.userId, guestUserId))), 1, "paid guest seat restored");
    const [reopened] = await db.select({ revokedAt: boardInvitations.revokedAt }).from(boardInvitations).where(eq(boardInvitations.id, invite!.id));
    assert.equal(reopened!.revokedAt, null, "guest invite re-opened");
    assert.equal(await db.$count(planActions, eq(planActions.clientId, clientId)), 0, "plan actions cleared after restore");
  });
});

void test("downgrade is a no-op in self-hosted mode", async () => {
  // env defaults to self_hosted in tests, so caps never apply.
  const clientId = await insertClient("Self Hosted Org");
  await insertWorkspace(clientId, "A", at(1));
  await insertWorkspace(clientId, "B", at(2));
  await insertWorkspace(clientId, "C", at(3));

  await convertClientPlan(clientId, { plan: "free", billingStatus: "canceled" });

  assert.equal(await db.$count(workspaces, and(eq(workspaces.clientId, clientId), isNull(workspaces.archivedAt))), 3, "nothing archived self-hosted");
  assert.equal(await db.$count(planActions, eq(planActions.clientId, clientId)), 0, "no plan actions recorded");
});

void test("downgrade keeps one protected owner and can suspend admins beyond the member cap", async () => {
  await withFreeCaps({ boards: 10, members: 2, automations: 10 }, async () => {
    const clientId = await insertClient("Owner Gap Org");
    const ownerA = await insertUser(clientId, "owner", at(0));
    const ownerB = await insertUser(clientId, "owner", at(1));
    const ownerC = await insertUser(clientId, "owner", at(2));
    const admin = await insertUser(clientId, "admin", at(3));

    await convertClientPlan(clientId, { plan: "free", billingStatus: "canceled" });

    const rows = await db
      .select({ id: users.id, suspendedAt: users.suspendedAt })
      .from(users)
      .where(inArray(users.id, [ownerA, ownerB, ownerC, admin]));
    const byId = new Map(rows.map((row) => [row.id, row.suspendedAt]));
    assert.equal(byId.get(ownerA), null, "oldest owner is the protected owner");
    assert.equal(byId.get(ownerB), null, "oldest remaining user fills the final free slot");
    assert.notEqual(byId.get(ownerC), null, "additional owners are not all immune");
    assert.notEqual(byId.get(admin), null, "admins can be suspended when beyond the free cap");
    assert.equal(await db.$count(users, and(eq(users.clientId, clientId), isNull(users.suspendedAt), isNull(users.removedAt))), 2);
  });
});

void test("downgrade preview uses the same owner/admin suspension rule as conversion", async () => {
  await withFreeCaps({ boards: 10, members: 1, automations: 10 }, async () => {
    const clientId = await insertClient("Preview Owner Gap Org");
    await insertUser(clientId, "owner", at(0));
    await insertUser(clientId, "owner", at(1));
    await insertUser(clientId, "admin", at(2));

    const { previewDowngradeImpact } = await import("./billing-emails.js");
    const impact = await previewDowngradeImpact(clientId);

    assert.equal(impact.usersSuspended, 2);
  });
});

void test("suspended members cannot log in or refresh", async () => {
  const prevMode = env.KANERA_DEPLOYMENT_MODE;
  env.KANERA_DEPLOYMENT_MODE = "hosted";
  try {
    const app = await buildIntegrationServer();
    const email = `owner-${randomUUID()}@example.com`;
    const signup = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { orgName: "Auth Org", email, password: "Abc12345", displayName: "Owner" },
    });
    assert.equal(signup.statusCode, 200);

    // Establish a refresh cookie while still active.
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: "Abc12345" } });
    assert.equal(login.statusCode, 200);
    const refreshCookie = login.cookies.find((c) => c.name === "kanera_rt")!;

    // Suspend the user (as a downgrade would) and assert both auth paths reject them.
    await db.update(users).set({ suspendedAt: new Date() }).where(eq(users.email, email));

    const blockedLogin = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: "Abc12345" } });
    assert.equal(blockedLogin.statusCode, 401);

    const blockedRefresh = await app.inject({ method: "POST", url: "/auth/refresh", cookies: { kanera_rt: refreshCookie.value } });
    assert.equal(blockedRefresh.statusCode, 401);
  } finally {
    env.KANERA_DEPLOYMENT_MODE = prevMode;
  }
});
