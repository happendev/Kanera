import "../test/setup.integration.js";
import { asyncLocalStorage, requestContext } from "@fastify/request-context";
import { boardMembers, boards, cardAssignees, cardChecklistItems, cardChecklists, cards, clients, lists, users, workspaceMembers, workspaces } from "@kanera/shared/schema";
import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { db } from "../db.js";
import "../test/integration.js";
import { AppError } from "./errors.js";
import { assertBoardAccess, assertBoardManageAccess, assertCardAccess, assertWorkspaceAccess } from "./access.js";

const fixture = {
  clientId: "00000000-0000-0000-0000-000000000101",
  userId: "00000000-0000-0000-0000-000000000102",
  workspaceId: "00000000-0000-0000-0000-000000000103",
  boardId: "00000000-0000-0000-0000-000000000104",
  visibleBoardId: "00000000-0000-0000-0000-000000000105",
};

// A separate organisation (clients row) with its own user. The one-org-per-user invariant means
// this user must never reach org A's workspace or boards through the access helpers.
const otherOrg = {
  clientId: "00000000-0000-0000-0000-0000000002a1",
  userId: "00000000-0000-0000-0000-0000000002a2",
};

const claims = {
  sub: fixture.userId,
  cid: fixture.clientId,
  role: "member" as const,
};

const otherOrgClaims = {
  sub: otherOrg.userId,
  cid: otherOrg.clientId,
  role: "member" as const,
};

// A personal API key acts as its owner: it carries authKind "apiKey" + apiKeyKind "personal" and no
// workspace pin, so access.ts evaluates it through the owner's real memberships (board content only).
const personalKeyClaims = {
  ...claims,
  authKind: "apiKey" as const,
  apiKeyKind: "personal" as const,
  apiKeyId: "00000000-0000-0000-0000-0000000000ff",
};

async function assertForbidden(promise: Promise<unknown>) {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof AppError, `expected AppError, got ${String(err)}`);
    // Cross-tenant access must be denied, never silently granted. Either a 403 (resource visible
    // but not the caller's org) or a 404 (resource hidden) is acceptable; a 2xx is the failure.
    assert.ok(err.statusCode === 403 || err.statusCode === 404, `expected 403/404, got ${err.statusCode}`);
    return true;
  });
}

async function runWithRequestContext(requestId: string, callback: () => Promise<void>) {
  await asyncLocalStorage.run({} as Parameters<typeof asyncLocalStorage.run>[0], async () => {
    requestContext.set("requestId", requestId);
    await callback();
  });
}

async function seedAccessFixture() {
  await db.insert(clients).values({ id: fixture.clientId, name: "Acme" });
  await db.insert(users).values({
    id: fixture.userId,
    clientId: fixture.clientId,
    email: "member@example.com",
    passwordHash: "hash",
    displayName: "Member",
  });
  await db.insert(workspaces).values({
    id: fixture.workspaceId,
    clientId: fixture.clientId,
    name: "Delivery",
  });
}

void test("assertWorkspaceAccess stores workspaceId in request context", async () => {
  await seedAccessFixture();
  await db.insert(workspaceMembers).values({
    workspaceId: fixture.workspaceId,
    userId: fixture.userId,
    role: "member",
  });

  await runWithRequestContext("request-workspace", async () => {
    const ctx = await assertWorkspaceAccess(claims, fixture.workspaceId);

    assert.equal(ctx.workspaceId, fixture.workspaceId);
    assert.equal(requestContext.get("workspaceId"), fixture.workspaceId);
  });
});

void test("assertBoardAccess stores workspaceId in request context", async () => {
  await seedAccessFixture();
  await db.insert(boards).values({
    id: fixture.boardId,
    workspaceId: fixture.workspaceId,
    name: "Project board",
    position: "1000.0000000000",
  });
  await db.insert(workspaceMembers).values({
    workspaceId: fixture.workspaceId,
    userId: fixture.userId,
    role: "member",
  });
  // Board membership is the access model, so a board_member row is required for access.
  await db.insert(boardMembers).values({
    boardId: fixture.boardId,
    userId: fixture.userId,
    role: "editor",
  });

  await runWithRequestContext("request-board", async () => {
    const ctx = await assertBoardAccess(claims, fixture.boardId);

    assert.equal(ctx.workspaceId, fixture.workspaceId);
    assert.equal(ctx.role, "editor");
    assert.equal(ctx.source, "board");
    assert.equal(ctx.canAccessWorkspace, true);
    assert.equal(requestContext.get("workspaceId"), fixture.workspaceId);
  });
});

void test("assertBoardAccess forbids a workspace member with no board_member row", async () => {
  await seedAccessFixture();
  await db.insert(boards).values({
    id: fixture.boardId,
    workspaceId: fixture.workspaceId,
    name: "Project board",
    position: "1000.0000000000",
  });
  // A workspace member no longer gets implicit board access: without an explicit board_member
  // row (and not being an org admin) they must be forbidden.
  await db.insert(workspaceMembers).values({
    workspaceId: fixture.workspaceId,
    userId: fixture.userId,
    role: "member",
  });

  await runWithRequestContext("request-board-no-membership", async () => {
    await assertForbidden(assertBoardAccess(claims, fixture.boardId));
  });
});

void test("assertBoardAccess hides archived boards from direct access", async () => {
  await seedAccessFixture();
  await db.insert(boards).values({
    id: fixture.boardId,
    workspaceId: fixture.workspaceId,
    name: "Archived board",
    position: "1000.0000000000",
    archivedAt: new Date("2026-01-10T00:00:00.000Z"),
  });
  await db.insert(boardMembers).values({
    boardId: fixture.boardId,
    userId: fixture.userId,
    role: "editor",
  });

  await runWithRequestContext("request-archived-board", async () => {
    await assertForbidden(assertBoardAccess(claims, fixture.boardId));
  });
});

void test("assertCardAccess enforces direct or checklist assignment for restricted members", async () => {
  await seedAccessFixture();
  await db.insert(boards).values({ id: fixture.boardId, workspaceId: fixture.workspaceId, name: "Project board", position: "1000.0000000000" });
  await db.insert(workspaceMembers).values({ workspaceId: fixture.workspaceId, userId: fixture.userId, role: "member" });
  await db.insert(boardMembers).values({ boardId: fixture.boardId, userId: fixture.userId, role: "editor", assignedItemsOnly: true });
  const [list] = await db.insert(lists).values({ workspaceId: fixture.workspaceId, name: "Todo", position: "1000.0000000000" }).returning();
  const [direct, checklist, hidden] = await db.insert(cards).values([
    { boardId: fixture.boardId, listId: list!.id, title: "Direct", position: "1000.0000000000", createdById: fixture.userId },
    { boardId: fixture.boardId, listId: list!.id, title: "Checklist", position: "2000.0000000000", createdById: fixture.userId },
    { boardId: fixture.boardId, listId: list!.id, title: "Hidden", position: "3000.0000000000", createdById: fixture.userId },
  ]).returning();
  await db.insert(cardAssignees).values({ cardId: direct!.id, userId: fixture.userId });
  const [checklistRow] = await db.insert(cardChecklists).values({ cardId: checklist!.id, title: "Tasks", position: "1000.0000000000" }).returning();
  await db.insert(cardChecklistItems).values({ checklistId: checklistRow!.id, text: "Owned", position: "1000.0000000000", assigneeId: fixture.userId, completedAt: new Date() });

  await runWithRequestContext("request-restricted-cards", async () => {
    assert.equal((await assertCardAccess(claims, direct!.id, "editor")).assignedItemsOnly, true);
    await assertCardAccess(claims, checklist!.id, "editor");
    await assertForbidden(assertCardAccess(claims, hidden!.id));
  });
});

void test("assertBoardAccess enforces the board_member role rank", async () => {
  await seedAccessFixture();
  await db.insert(boards).values({
    id: fixture.boardId,
    workspaceId: fixture.workspaceId,
    name: "Project board",
    position: "1000.0000000000",
  });
  await db.insert(workspaceMembers).values({
    workspaceId: fixture.workspaceId,
    userId: fixture.userId,
    role: "admin",
  });
  // The effective role comes from the board_member row, independent of the workspace role.
  await db.insert(boardMembers).values({
    boardId: fixture.boardId,
    userId: fixture.userId,
    role: "observer",
  });

  await runWithRequestContext("request-board-observer", async () => {
    const ctx = await assertBoardAccess(claims, fixture.boardId);
    assert.equal(ctx.role, "observer");
    // Observer can read but not act as editor.
    await assertForbidden(assertBoardAccess(claims, fixture.boardId, "editor"));
  });
});

void test("assertBoardAccess grants an org admin implicit access without a board_member row", async () => {
  await seedAccessFixture();
  await db.insert(boards).values({
    id: fixture.boardId,
    workspaceId: fixture.workspaceId,
    name: "Project board",
    position: "1000.0000000000",
  });
  await db.update(users).set({ clientRole: "admin" }).where(eq(users.id, fixture.userId));
  const orgAdminClaims = { ...claims, role: "admin" as const };

  await runWithRequestContext("request-board-org-admin", async () => {
    // Org admins short-circuit to full board access, surfaced as an `editor` role.
    const ctx = await assertBoardAccess(orgAdminClaims, fixture.boardId, "editor");
    assert.equal(ctx.role, "editor");
    assert.equal(ctx.workspaceId, fixture.workspaceId);
  });
});

async function seedCrossTenantFixture() {
  // Org A owns the workspace + boards.
  await seedAccessFixture();
  await db.insert(boards).values([
    {
      id: fixture.boardId,
      workspaceId: fixture.workspaceId,
      name: "Project board",
      position: "1000.0000000000",
    },
    {
      id: fixture.visibleBoardId,
      workspaceId: fixture.workspaceId,
      name: "Workspace board",
      position: "2000.0000000000",
    },
  ]);
  // Org B is a different tenant whose user has no membership in org A.
  await db.insert(clients).values({ id: otherOrg.clientId, name: "Globex" });
  await db.insert(users).values({
    id: otherOrg.userId,
    clientId: otherOrg.clientId,
    email: "intruder@example.com",
    passwordHash: "hash",
    displayName: "Intruder",
  });
}

void test("assertWorkspaceAccess denies a user from another org", async () => {
  await seedCrossTenantFixture();
  await runWithRequestContext("request-cross-workspace", async () => {
    await assertForbidden(assertWorkspaceAccess(otherOrgClaims, fixture.workspaceId));
  });
});

void test("assertBoardAccess denies a user from another org on a workspace-visible board", async () => {
  await seedCrossTenantFixture();
  await runWithRequestContext("request-cross-board-visible", async () => {
    await assertForbidden(assertBoardAccess(otherOrgClaims, fixture.visibleBoardId));
  });
});

void test("assertBoardAccess denies a user from another org without board guest access", async () => {
  await seedCrossTenantFixture();
  await runWithRequestContext("request-cross-board-private", async () => {
    await assertForbidden(assertBoardAccess(otherOrgClaims, fixture.boardId));
  });
});

void test("an org admin cannot reach another org's workspace or board", async () => {
  await seedCrossTenantFixture();
  // Even an org-level admin is scoped to their own client; the admin bypass requires same cid.
  const otherOrgAdmin = { ...otherOrgClaims, role: "admin" as const };
  await runWithRequestContext("request-cross-admin", async () => {
    await assertForbidden(assertWorkspaceAccess(otherOrgAdmin, fixture.workspaceId));
    await assertForbidden(assertBoardAccess(otherOrgAdmin, fixture.visibleBoardId));
  });
});

void test("a personal key inherits the owner's board and workspace-admin permissions", async () => {
  await seedAccessFixture();
  await db.insert(boards).values({ id: fixture.boardId, workspaceId: fixture.workspaceId, name: "Project board", position: "1000.0000000000" });
  await db.insert(workspaceMembers).values({ workspaceId: fixture.workspaceId, userId: fixture.userId, role: "admin" });
  // Owner is an editor on this board. The personal key should get editor content access...
  await db.insert(boardMembers).values({ boardId: fixture.boardId, userId: fixture.userId, role: "editor" });

  await runWithRequestContext("request-personal-editor", async () => {
    const ctx = await assertBoardAccess(personalKeyClaims, fixture.boardId, "editor");
    assert.equal(ctx.role, "editor");
    assert.equal(ctx.isWorkspaceAdmin, true);
    await assertBoardManageAccess(personalKeyClaims, fixture.boardId);
  });
});

void test("a personal key is observer-blocked where the owner is only an observer", async () => {
  await seedAccessFixture();
  await db.insert(boards).values({ id: fixture.boardId, workspaceId: fixture.workspaceId, name: "Project board", position: "1000.0000000000" });
  await db.insert(workspaceMembers).values({ workspaceId: fixture.workspaceId, userId: fixture.userId, role: "member" });
  await db.insert(boardMembers).values({ boardId: fixture.boardId, userId: fixture.userId, role: "observer" });

  await runWithRequestContext("request-personal-observer", async () => {
    const ctx = await assertBoardAccess(personalKeyClaims, fixture.boardId);
    assert.equal(ctx.role, "observer");
    // Editor/observer is enforced: an observer owner's personal key cannot mutate board content.
    await assertForbidden(assertBoardAccess(personalKeyClaims, fixture.boardId, "editor"));
  });
});

void test("a personal key from an org admin inherits organisation-wide workspace-admin power", async () => {
  await seedAccessFixture();
  await db.insert(boards).values({ id: fixture.boardId, workspaceId: fixture.workspaceId, name: "Project board", position: "1000.0000000000" });
  // Owner is an org admin with no board_member row: they can still reach every org board for content.
  await db.update(users).set({ clientRole: "admin" }).where(eq(users.id, fixture.userId));
  const orgAdminPersonalKey = { ...personalKeyClaims, role: "admin" as const };

  await runWithRequestContext("request-personal-org-admin", async () => {
    const boardCtx = await assertBoardAccess(orgAdminPersonalKey, fixture.boardId, "editor");
    assert.equal(boardCtx.role, "editor");
    assert.equal(boardCtx.isWorkspaceAdmin, true);
    const wsCtx = await assertWorkspaceAccess(orgAdminPersonalKey, fixture.workspaceId);
    assert.equal(wsCtx.role, "admin");
    await assertWorkspaceAccess(orgAdminPersonalKey, fixture.workspaceId, "admin");
  });
});

void test("a personal key reaches a cross-org guest board via board membership", async () => {
  await seedCrossTenantFixture();
  // Org B's user is a guest editor on Org A's board. Their personal key must reach it, cross-org.
  await db.insert(boardMembers).values({ boardId: fixture.boardId, userId: otherOrg.userId, role: "editor" });
  const guestPersonalKey = { ...otherOrgClaims, authKind: "apiKey" as const, apiKeyKind: "personal" as const, apiKeyId: "00000000-0000-0000-0000-0000000000fe" };

  await runWithRequestContext("request-personal-guest", async () => {
    const ctx = await assertBoardAccess(guestPersonalKey, fixture.boardId, "editor");
    assert.equal(ctx.role, "editor");
    // A cross-org guest has no workspace membership, so no workspace-admin power.
    assert.equal(ctx.isWorkspaceAdmin, false);
  });
});

void test("a personal key cannot reach a board the owner has no access to", async () => {
  await seedCrossTenantFixture();
  const intruderPersonalKey = { ...otherOrgClaims, authKind: "apiKey" as const, apiKeyKind: "personal" as const, apiKeyId: "00000000-0000-0000-0000-0000000000fd" };
  await runWithRequestContext("request-personal-intruder", async () => {
    await assertForbidden(assertBoardAccess(intruderPersonalKey, fixture.boardId));
  });
});
