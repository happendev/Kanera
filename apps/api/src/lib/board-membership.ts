import { boardMembers, boards, users, workspaceMembers, workspaces } from "@kanera/shared/schema";
import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";
import type { Db } from "../db.js";

type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Seed a freshly created board with pinned `editor` rows for every workspace admin. Standalone boards
 * also include every active organisation owner/admin because their hidden workspace has no product-
 * facing roster where that inherited access could otherwise be represented. Board membership is the
 * content-access model, so both kinds of inherited access are materialized as non-removable rows.
 *
 * Regular members are intentionally NOT auto-added — they are granted access explicitly per board.
 * `onConflictDoUpdate` re-pins any pre-existing row (idempotent), forcing role=editor + pinned=true
 * and removing card-level restrictions because administrators always have full board visibility.
 */
export async function seedBoardMembersFromWorkspace(
  tx: Tx,
  boardId: string,
  workspaceId: string,
  _creatorId: string,
): Promise<void> {
  const workspaceAdmins = await tx
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, "admin")));
  const [workspace] = await tx
    .select({ clientId: workspaces.clientId, kind: workspaces.kind })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const orgAdmins = workspace?.kind === "board"
    ? await tx
      .select({ userId: users.id })
      .from(users)
      .where(and(
        eq(users.clientId, workspace.clientId),
        inArray(users.clientRole, ["owner", "admin"]),
        isNull(users.removedAt),
        isNull(users.deletedAt),
      ))
    : [];
  const adminIds = [...new Set([...workspaceAdmins, ...orgAdmins].map((admin) => admin.userId))];
  if (adminIds.length === 0) return;

  await tx
    .insert(boardMembers)
    .values(adminIds.map((userId) => ({ boardId, userId, role: "editor" as const, pinned: true })))
    .onConflictDoUpdate({
      target: [boardMembers.boardId, boardMembers.userId],
      set: { role: "editor", pinned: true, assignedItemsOnly: false },
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
      set: { role: "editor", pinned: true, assignedItemsOnly: false },
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
  const boardIds = boardRows.map((board) => board.id);
  // Existing explicit memberships stay explicit so demotion can restore their original role, but
  // the restrictive visibility flag must be permanently cleared on promotion.
  await tx
    .update(boardMembers)
    .set({ assignedItemsOnly: false })
    .where(and(eq(boardMembers.userId, userId), inArray(boardMembers.boardId, boardIds)));
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
