import type { BoardInviteKind } from "@kanera/shared/dto";
import { boardInvitationGrants, boardInvitations, inviteBoardGrants, inviteTokens, inviteWorkspaceGrants } from "@kanera/shared/schema";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { assertOrgRole } from "../../lib/access.js";
import { notFound } from "../../lib/errors.js";
import { emitToClient } from "../../realtime/emit.js";
import type { BoardAccessContext } from "./route-support.js";

/**
 * Open invitations that would grant this board, for the members menu. Two stores feed it: guest
 * invitations (email-bound, one person outside the organisation) and organisation invites (links or
 * emails that make someone a member). Organisation invite links are multi-use until they expire or
 * are revoked, so "pending" there means "still redeemable", not "not yet accepted".
 */
export async function loadBoardInvites({ ctx, boardId }: { ctx: BoardAccessContext; boardId: string }) {
  const [guestInvites, memberInvites] = await Promise.all([
    db
      .select({
        id: boardInvitations.id,
        email: boardInvitations.email,
        role: boardInvitationGrants.role,
        assignedItemsOnly: boardInvitationGrants.assignedItemsOnly,
        expiresAt: boardInvitations.expiresAt,
        createdAt: boardInvitations.createdAt,
      })
      .from(boardInvitations)
      .innerJoin(boardInvitationGrants, eq(boardInvitationGrants.invitationId, boardInvitations.id))
      .where(and(
        eq(boardInvitationGrants.boardId, boardId),
        eq(boardInvitations.clientId, ctx.clientId),
        isNull(boardInvitations.revokedAt),
        isNull(boardInvitations.acceptedAt),
        sql`(${boardInvitations.expiresAt} is null or ${boardInvitations.expiresAt} > now())`,
      ))
      .orderBy(asc(boardInvitations.createdAt)),
    db
      .select({
        id: inviteTokens.id,
        email: inviteTokens.email,
        role: inviteBoardGrants.role,
        expiresAt: inviteTokens.expiresAt,
        createdAt: inviteTokens.createdAt,
      })
      .from(inviteTokens)
      .innerJoin(inviteBoardGrants, eq(inviteBoardGrants.inviteId, inviteTokens.id))
      .where(and(
        eq(inviteBoardGrants.boardId, boardId),
        eq(inviteTokens.clientId, ctx.clientId),
        isNull(inviteTokens.revokedAt),
        sql`(${inviteTokens.expiresAt} is null or ${inviteTokens.expiresAt} > now())`,
      ))
      .orderBy(asc(inviteTokens.createdAt)),
  ]);
  return [
    ...guestInvites.map((invite) => ({ ...invite, kind: "guest" as const })),
    // Organisation invite board grants carry no restriction; the member sees the whole board.
    ...memberInvites.map((invite) => ({ ...invite, kind: "member" as const, assignedItemsOnly: false })),
  ].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

/**
 * Withdraws this board from an invitation. An invitation can carry several boards (settings can add
 * more to a pending guest invite), so only this board's grant goes; the invitation itself is revoked
 * once nothing is left for it to grant. Without that, a guest invitation with no grants would fall
 * back to its primary board on redemption, and an organisation invite would admit a member to nothing.
 */
export async function revokeBoardInvite({ auth, ctx, boardId, inviteId, kind }: {
  auth: AuthClaims;
  ctx: BoardAccessContext;
  boardId: string;
  inviteId: string;
  kind: BoardInviteKind;
}) {
  if (kind === "guest") {
    return db.transaction(async (tx) => {
      const [invitation] = await tx
        .select({ id: boardInvitations.id })
        .from(boardInvitations)
        .innerJoin(boardInvitationGrants, eq(boardInvitationGrants.invitationId, boardInvitations.id))
        .where(and(eq(boardInvitations.id, inviteId), eq(boardInvitations.clientId, ctx.clientId), eq(boardInvitationGrants.boardId, boardId)))
        .for("update", { of: boardInvitations })
        .limit(1);
      if (!invitation) throw notFound();
      await tx.delete(boardInvitationGrants).where(and(eq(boardInvitationGrants.invitationId, inviteId), eq(boardInvitationGrants.boardId, boardId)));
      const [remaining] = await tx.select({ boardId: boardInvitationGrants.boardId }).from(boardInvitationGrants).where(eq(boardInvitationGrants.invitationId, inviteId)).limit(1);
      if (!remaining) await tx.update(boardInvitations).set({ revokedAt: new Date() }).where(eq(boardInvitations.id, inviteId));
      return { revoked: !remaining, clientId: ctx.clientId, inviteId, kind };
    });
  }

  // Organisation invites are an organisation-admin power everywhere else (create, list, revoke), and
  // workspace admins cannot create them from this menu either, so withdrawing one stays with them.
  assertOrgRole(auth, "admin");
  return db.transaction(async (tx) => {
    const [invite] = await tx
      .select({ id: inviteTokens.id, orgRole: inviteTokens.orgRole })
      .from(inviteTokens)
      .innerJoin(inviteBoardGrants, eq(inviteBoardGrants.inviteId, inviteTokens.id))
      .where(and(eq(inviteTokens.id, inviteId), eq(inviteTokens.clientId, ctx.clientId), eq(inviteBoardGrants.boardId, boardId)))
      .for("update", { of: inviteTokens })
      .limit(1);
    if (!invite) throw notFound();
    await tx.delete(inviteBoardGrants).where(and(eq(inviteBoardGrants.inviteId, inviteId), eq(inviteBoardGrants.boardId, boardId)));
    const [[otherBoard], [workspaceGrant]] = await Promise.all([
      tx.select({ boardId: inviteBoardGrants.boardId }).from(inviteBoardGrants).where(eq(inviteBoardGrants.inviteId, inviteId)).limit(1),
      tx.select({ workspaceId: inviteWorkspaceGrants.workspaceId }).from(inviteWorkspaceGrants).where(eq(inviteWorkspaceGrants.inviteId, inviteId)).limit(1),
    ]);
    // An admin invite reaches every board through the organisation role, so losing one board grant
    // never empties it.
    const revoked = invite.orgRole === "member" && !otherBoard && !workspaceGrant;
    if (revoked) await tx.update(inviteTokens).set({ revokedAt: new Date() }).where(eq(inviteTokens.id, inviteId));
    return { revoked, clientId: ctx.clientId, inviteId, kind };
  });
}

export function emitRevokeBoardInvite({ revoked, clientId, inviteId, kind }: Awaited<ReturnType<typeof revokeBoardInvite>>) {
  // Organisation settings keep a live invite list; a guest invitation list has no realtime feed.
  if (revoked && kind === "member") emitToClient(clientId, "client:invite:revoked", { id: inviteId });
}
