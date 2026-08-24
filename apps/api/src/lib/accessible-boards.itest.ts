import "../test/setup.integration.js";
import { insertTestUsers } from "../test/user-fixtures.js";
import { asyncLocalStorage } from "@fastify/request-context";
import { boardMembers, boards, clients, workspaceMembers, workspaces } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuthClaims } from "../auth/plugin.js";
import { db } from "../db.js";
import { loadAccessibleBoards } from "./accessible-boards.js";
import "../test/integration.js";

/**
 * `loadAccessibleBoards` memoizes per request. These tests gate the two properties that make that
 * safe: the memo must collapse repeat calls inside one request, and it must never be visible from
 * another request — an access change has to take effect on the very next one, with no expiry to wait
 * for.
 */

async function seedFixture() {
  const [client] = await db.insert(clients).values({ name: "Memo Co" }).returning();
  const [user] = await insertTestUsers(db, {
    clientId: client!.id,
    email: `memo-${Date.now()}@example.com`,
    passwordHash: "x",
    displayName: "Memo Viewer",
  }).returning();
  const [workspace] = await db.insert(workspaces).values({ clientId: client!.id, name: "Memo Space" }).returning();
  await db.insert(workspaceMembers).values({ workspaceId: workspace!.id, userId: user!.id, role: "admin" });
  const [boardA, boardB] = await db.insert(boards).values([
    { workspaceId: workspace!.id, name: "Memo A", position: "1000.0000000000" },
    { workspaceId: workspace!.id, name: "Memo B", position: "2000.0000000000" },
  ]).returning();
  await db.insert(boardMembers).values([
    { boardId: boardA!.id, userId: user!.id, role: "editor" },
    { boardId: boardB!.id, userId: user!.id, role: "editor" },
  ]);
  assert.ok(user);
  assert.ok(workspace);
  assert.ok(boardA);
  assert.ok(boardB);
  const claims: AuthClaims = { sub: user.id, cid: client!.id, authKind: "user" } as AuthClaims;
  return { claims, workspaceId: workspace.id, boardAId: boardA.id, boardBId: boardB.id };
}

/** One AsyncLocalStorage run stands in for one request, which is exactly the memo's lifetime. */
async function inRequest<T>(callback: () => Promise<T>): Promise<T> {
  return asyncLocalStorage.run({} as Parameters<typeof asyncLocalStorage.run>[0], callback);
}

void test("repeat calls within one request return the identical memoized result", async () => {
  const f = await seedFixture();
  const [first, second, third] = await inRequest(async () => Promise.all([
    loadAccessibleBoards(f.claims),
    loadAccessibleBoards(f.claims),
    loadAccessibleBoards(f.claims),
  ]));
  // Same array instance, so the concurrent callers shared one in-flight load rather than racing
  // three of them.
  assert.equal(first, second);
  assert.equal(second, third);
  // A sequential call after the batch settles must also hit the memo.
  const sequential = await inRequest(async () => {
    const a = await loadAccessibleBoards(f.claims);
    const b = await loadAccessibleBoards(f.claims);
    return { a, b };
  });
  assert.equal(sequential.a, sequential.b);
  assert.ok(sequential.a.some((board) => board.id === f.boardAId));
  assert.ok(sequential.a.some((board) => board.id === f.boardBId));
});

void test("a separate request never reads the previous request's memo", async () => {
  const f = await seedFixture();
  const before = await inRequest(() => loadAccessibleBoards(f.claims));
  assert.equal(before.length, 2);

  // Archive one board *between* requests. A memo that outlived its request would keep serving the
  // stale two-board answer; the whole point of request scope is that it cannot.
  await db.update(boards).set({ archivedAt: new Date() }).where(eq(boards.id, f.boardBId));

  const after = await inRequest(() => loadAccessibleBoards(f.claims));
  assert.notEqual(before, after);
  assert.deepEqual(after.map((board) => board.id), [f.boardAId]);
});

void test("calls outside any request context still resolve, uncached", async () => {
  const f = await seedFixture();
  // Worker schedulers and scripts run with no request context at all; the memo must degrade to a
  // plain call rather than throw.
  const first = await loadAccessibleBoards(f.claims);
  const second = await loadAccessibleBoards(f.claims);
  assert.equal(first.length, 2);
  assert.notEqual(first, second);
});
