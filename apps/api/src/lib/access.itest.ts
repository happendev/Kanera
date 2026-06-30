import "../test/setup.integration.js";
import { asyncLocalStorage, requestContext } from "@fastify/request-context";
import { boardMembers, boards, clients, users, workspaceMembers, workspaces } from "@kanera/shared/schema";
import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../db.js";
import "../test/integration.js";
import { AppError } from "./errors.js";
import { assertBoardAccess, assertWorkspaceAccess } from "./access.js";

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
    role: "editor",
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
    name: "Private board",
    position: "1000.0000000000",
    visibility: "private",
  });
  await db.insert(boardMembers).values({
    boardId: fixture.boardId,
    userId: fixture.userId,
    role: "editor",
  });

  await runWithRequestContext("request-board", async () => {
    const ctx = await assertBoardAccess(claims, fixture.boardId);

    assert.equal(ctx.workspaceId, fixture.workspaceId);
    assert.equal(requestContext.get("workspaceId"), fixture.workspaceId);
  });
});

async function seedCrossTenantFixture() {
  // Org A owns the workspace + boards.
  await seedAccessFixture();
  await db.insert(boards).values([
    {
      id: fixture.boardId,
      workspaceId: fixture.workspaceId,
      name: "Private board",
      position: "1000.0000000000",
      visibility: "private",
    },
    {
      id: fixture.visibleBoardId,
      workspaceId: fixture.workspaceId,
      name: "Workspace board",
      position: "2000.0000000000",
      visibility: "workspace",
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

void test("assertBoardAccess denies a user from another org on a private board", async () => {
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
