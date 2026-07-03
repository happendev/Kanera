import { boardMembers, boards, workspaceMembers, workspaces } from "@kanera/shared/schema";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import type { Db } from "../db.js";

type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Seed a freshly created board with pinned `editor` rows for every workspace admin. Board membership
 * is the content-access model, and the product invariant is that workspace admins are on every board;
 * we materialize that as explicit pinned rows (non-removable/non-downgradable while the user is an
 * admin) rather than an implicit access grant, so `board_member` stays the single source of truth.
 *
 * Regular members are intentionally NOT auto-added — they are granted access explicitly per board.
 * Board creation requires workspace-admin authority, but an org owner/admin creator who has no
 * workspace_members row is NOT seeded here: their editor access comes from the org short-circuit in
 * access.ts, and GET /boards/:id/members synthesizes them as a pinned admin. So the creator only ends
 * up with a materialized row when they hold an explicit workspace_members admin role.
 *
 * `onConflictDoUpdate` re-pins any pre-existing row (idempotent), forcing role=editor + pinned=true.
 */
export async function seedBoardMembersFromWorkspace(
  tx: Tx,
  boardId: string,
  workspaceId: string,
  _creatorId: string,
): Promise<void> {
  const admins = await tx
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, "admin")));
  if (admins.length === 0) return;

  await tx
    .insert(boardMembers)
    .values(admins.map((a) => ({ boardId, userId: a.userId, role: "editor" as const, pinned: true })))
    .onConflictDoUpdate({
      target: [boardMembers.boardId, boardMembers.userId],
      set: { role: "editor", pinned: true },
    });
}

/**
 * A user was promoted to workspace admin: materialize a pinned editor row on every board in the
 * workspace so the "admins are on every board" invariant holds immediately.
 */
export async function pinAdminToWorkspaceBoards(tx: Tx, workspaceId: string, userId: string): Promise<void> {
  const boardRows = await tx.select({ id: boards.id }).from(boards).where(eq(boards.workspaceId, workspaceId));
  if (boardRows.length === 0) return;
  await tx
    .insert(boardMembers)
    .values(boardRows.map((b) => ({ boardId: b.id, userId, role: "editor" as const, pinned: true })))
    .onConflictDoUpdate({
      target: [boardMembers.boardId, boardMembers.userId],
      set: { role: "editor", pinned: true },
    });
}

/**
 * A user was demoted from workspace admin: retain access to the boards they administered, but turn
 * inherited pinned rows into ordinary editor memberships so board admins can change/remove them.
 */
export async function unpinAdminFromWorkspaceBoards(tx: Tx, workspaceId: string, userId: string): Promise<void> {
  await tx
    .update(boardMembers)
    .set({ role: "editor", pinned: false })
    .where(
      and(
        eq(boardMembers.userId, userId),
        eq(boardMembers.pinned, true),
        inArray(
          boardMembers.boardId,
          tx.select({ id: boards.id }).from(boards).where(eq(boards.workspaceId, workspaceId)),
        ),
      ),
    );
}

/** Materialize an organisation owner's/admin's inherited editor access on every board. */
export async function pinOrgAdminToClientBoards(tx: Tx, clientId: string, userId: string): Promise<void> {
  const boardRows = await tx
    .select({ id: boards.id })
    .from(boards)
    .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
    .where(eq(workspaces.clientId, clientId));
  if (boardRows.length === 0) return;
  await tx
    .insert(boardMembers)
    .values(boardRows.map((board) => ({ boardId: board.id, userId, role: "editor" as const, pinned: true })))
    // Preserve any explicit observer/editor row. Organisation authority overrides it while the
    // user is an admin; after demotion that original grant becomes effective again.
    .onConflictDoNothing();
}

/** Remove org-inherited pins after demotion, retaining pins justified by workspace-admin roles. */
export async function unpinOrgAdminFromClientBoards(tx: Tx, clientId: string, userId: string): Promise<void> {
  const adminWorkspaceIds = tx
    .select({ id: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.role, "admin")));
  const inheritedBoardIds = tx
    .select({ id: boards.id })
    .from(boards)
    .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
    .where(and(eq(workspaces.clientId, clientId), notInArray(boards.workspaceId, adminWorkspaceIds)));
  await tx.delete(boardMembers).where(
    and(eq(boardMembers.userId, userId), eq(boardMembers.pinned, true), inArray(boardMembers.boardId, inheritedBoardIds)),
  );
}
