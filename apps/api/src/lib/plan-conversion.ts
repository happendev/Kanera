import {
  automations,
  boardInvitations,
  boardMembers,
  boards,
  clientGuestSeats,
  clients,
  planActions,
  users,
  webhookEndpoints,
  workspaceApiKeys,
  workspaces,
  type ClientBillingStatus,
  type ClientPlan,
  type NewPlanAction,
} from "@kanera/shared/schema";
import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db, type Db } from "../db.js";
import { env, type Env } from "../env.js";
import { disconnectUserRealtimeSockets } from "../realtime/io.js";
import { emitToBoard, emitToBoardAudience, emitToWorkspaceAdmins } from "../realtime/emit.js";
import { emitActivityFeedItem } from "./activity.js";
import { loadAutomation } from "./automations.js";
import { cleanupUserBoardParticipation, type BoardParticipationCleanup } from "./board-participation-cleanup.js";
import { isPaidTier } from "./entitlements.js";

type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

type PlanConversionEnv = Pick<
  Env,
  | "KANERA_DEPLOYMENT_MODE"
  | "HOSTED_FREE_MAX_BOARDS"
  | "HOSTED_FREE_MAX_ORG_MEMBERS"
  | "HOSTED_FREE_MAX_ENABLED_AUTOMATIONS"
>;

type PlanTarget = { plan: ClientPlan; billingStatus: ClientBillingStatus };
type RealtimeChanges = {
  userIdsToDisconnect: string[];
  boardMemberRemoved: { boardId: string; userId: string }[];
  assigneeUpdates: BoardParticipationCleanup["assigneeUpdates"];
  checklistItemUpdates: BoardParticipationCleanup["checklistItemUpdates"];
  activities: BoardParticipationCleanup["activities"];
  automationsUpdated: { workspaceId: string; automationId: string }[];
  boardsDeleted: { workspaceId: string; boardId: string }[];
};

export type ReactivatedPlanBoard = typeof boards.$inferSelect;

/**
 * Central entry point for changing an organisation's plan/billing tier. This is the single place a
 * Stripe webhook handler or an admin action should call; it keeps the `clients` row and the org's
 * resources consistent with the target tier.
 *
 * On a downgrade to free (hosted mode only) it disables resources that exceed the free caps and
 * records reversible actions in `plan_action`. On an upgrade to trial/paid it restores those
 * recorded resources. Self-hosted orgs are always unlimited, so only the `clients` row is updated.
 *
 * The whole conversion runs in one transaction so the `clients` row and the reconciliation can never
 * diverge. Pass an existing `tx` to enlist in a caller's transaction.
 */
export async function convertClientPlan(
  clientId: string,
  target: PlanTarget,
  tx?: Tx,
  config: PlanConversionEnv = env,
): Promise<void> {
  let changes: RealtimeChanges;
  if (tx) {
    changes = await applyConversion(clientId, target, tx, config);
  } else {
    changes = await db.transaction((t) => applyConversion(clientId, target, t, config));
  }

  for (const { workspaceId, automationId } of changes.automationsUpdated) {
    const automation = await loadAutomation(automationId);
    if (automation) await emitToWorkspaceAdmins(workspaceId, "automation:updated", { workspaceId, automation });
  }
  for (const { workspaceId, boardId } of changes.boardsDeleted) {
    await emitToBoardAudience(boardId, "board:deleted", { workspaceId, boardId }, { workspaceId });
  }
  for (const { boardId, userId } of changes.boardMemberRemoved) {
    await emitToBoard(boardId, "board:member:removed", { boardId, userId });
  }
  for (const update of changes.assigneeUpdates) {
    await emitToBoard(update.boardId, "card:assignees:set", update);
  }
  for (const update of changes.checklistItemUpdates) {
    await emitToBoard(update.boardId, "card:checklistItem:updated", update);
  }
  for (const update of changes.activities) {
    await emitActivityFeedItem(update.boardId, update.cardId, update.activity, { notify: false });
  }
  for (const userId of new Set(changes.userIdsToDisconnect)) {
    disconnectUserRealtimeSockets(userId);
  }
}

function emptyRealtimeChanges(): RealtimeChanges {
  return {
    userIdsToDisconnect: [],
    boardMemberRemoved: [],
    assigneeUpdates: [],
    checklistItemUpdates: [],
    activities: [],
    automationsUpdated: [],
    boardsDeleted: [],
  };
}

async function applyConversion(clientId: string, target: PlanTarget, tx: Tx, config: PlanConversionEnv): Promise<RealtimeChanges> {
  await tx
    .update(clients)
    .set({
      plan: target.plan,
      billingStatus: target.billingStatus,
      // Clear the trial/period end when leaving a paid tier so a downgraded org can't re-match the
      // trial-expiry sweep and no stale trial date lingers in the UI.
      ...(isPaidTier(target.billingStatus) ? {} : { currentPeriodEnd: null }),
      updatedAt: new Date(),
    })
    .where(eq(clients.id, clientId));

  // Caps only ever apply to hosted free-tier orgs; self-hosted and paid/trial are unlimited so there
  // is nothing to reconcile in either direction.
  if (config.KANERA_DEPLOYMENT_MODE !== "hosted") return emptyRealtimeChanges();

  if (isPaidTier(target.billingStatus)) {
    await restoreFromPlanActions(clientId, tx);
    return emptyRealtimeChanges();
  } else {
    return reconcileToFreeTier(clientId, tx, config);
  }
}

// Helper to append a plan_action row recording a single disable so it can be reversed on upgrade.
function actionRow(clientId: string, kind: NewPlanAction["kind"], payload: NewPlanAction["payload"]): NewPlanAction {
  return { clientId, kind, payload };
}

/**
 * Brings a now-free org back within every free-tier cap. Each step selects only resources that are
 * still live/over-limit, so it is idempotent and never records (and thus never auto-restores) a
 * resource the user disabled on their own. Workspaces are unlimited on Free, so only boards and
 * paid-only resources are reconciled.
 */
async function reconcileToFreeTier(clientId: string, tx: Tx, config: PlanConversionEnv): Promise<RealtimeChanges> {
  const pending: NewPlanAction[] = [];
  const changes = emptyRealtimeChanges();

  // --- Automations: keep the oldest N enabled, disable the rest. ---
  const enabledAutomations = await tx
    .select({ id: automations.id, workspaceId: automations.workspaceId })
    .from(automations)
    .innerJoin(workspaces, eq(workspaces.id, automations.workspaceId))
    .where(and(eq(workspaces.clientId, clientId), eq(automations.enabled, true)))
    .orderBy(asc(automations.createdAt));
  const automationsToDisable = enabledAutomations.slice(config.HOSTED_FREE_MAX_ENABLED_AUTOMATIONS);
  const automationIdsToDisable = automationsToDisable.map((a) => a.id);
  if (automationIdsToDisable.length > 0) {
    await tx.update(automations).set({ enabled: false, updatedAt: new Date() }).where(inArray(automations.id, automationIdsToDisable));
    for (const automation of automationsToDisable) {
      pending.push(actionRow(clientId, "automation_disabled", { automationId: automation.id }));
      changes.automationsUpdated.push({ workspaceId: automation.workspaceId, automationId: automation.id });
    }
  }

  // --- Webhooks: a paid-only feature, so disable every enabled endpoint. ---
  const enabledWebhooks = await tx
    .select({ id: webhookEndpoints.id })
    .from(webhookEndpoints)
    .innerJoin(workspaces, eq(workspaces.id, webhookEndpoints.workspaceId))
    .where(and(eq(workspaces.clientId, clientId), eq(webhookEndpoints.enabled, true)));
  if (enabledWebhooks.length > 0) {
    const ids = enabledWebhooks.map((w) => w.id);
    await tx.update(webhookEndpoints).set({ enabled: false, updatedAt: new Date() }).where(inArray(webhookEndpoints.id, ids));
    for (const id of ids) pending.push(actionRow(clientId, "webhook_disabled", { webhookId: id }));
  }

  // --- API keys: a paid-only feature, so revoke every active key. ---
  // Workspace keys are located via their workspace's client; personal keys have no workspace and are
  // located via their owner's client. Both are restored by id on re-upgrade (idsFor("api_key_revoked")).
  const activeWorkspaceApiKeys = await tx
    .select({ id: workspaceApiKeys.id })
    .from(workspaceApiKeys)
    .innerJoin(workspaces, eq(workspaces.id, workspaceApiKeys.workspaceId))
    .where(and(eq(workspaces.clientId, clientId), isNull(workspaceApiKeys.revokedAt)));
  const activePersonalApiKeys = await tx
    .select({ id: workspaceApiKeys.id })
    .from(workspaceApiKeys)
    .innerJoin(users, eq(users.id, workspaceApiKeys.createdById))
    .where(and(eq(workspaceApiKeys.kind, "personal"), eq(users.clientId, clientId), isNull(workspaceApiKeys.revokedAt)));
  const activeApiKeyIds = [...activeWorkspaceApiKeys, ...activePersonalApiKeys].map((k) => k.id);
  if (activeApiKeyIds.length > 0) {
    await tx.update(workspaceApiKeys).set({ revokedAt: new Date(), updatedAt: new Date() }).where(inArray(workspaceApiKeys.id, activeApiKeyIds));
    for (const id of activeApiKeyIds) pending.push(actionRow(clientId, "api_key_revoked", { apiKeyId: id }));
  }

  // --- Guests: a paid-only feature. Remove cross-org board members and revoke pending guest invites. ---
  const paidGuestSeats = await tx
    .select({ userId: clientGuestSeats.userId })
    .from(clientGuestSeats)
    .where(eq(clientGuestSeats.clientId, clientId));
  for (const seat of paidGuestSeats) {
    pending.push(actionRow(clientId, "guest_seat_removed", { userId: seat.userId }));
  }
  if (paidGuestSeats.length > 0) {
    await tx.delete(clientGuestSeats).where(eq(clientGuestSeats.clientId, clientId));
  }

  // A guest is a board member whose user belongs to a different org than the board's owning org.
  const guestMembers = await tx
    .select({ boardId: boardMembers.boardId, userId: boardMembers.userId, role: boardMembers.role })
    .from(boardMembers)
    .innerJoin(boards, eq(boards.id, boardMembers.boardId))
    .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
    .innerJoin(users, eq(users.id, boardMembers.userId))
    .where(and(eq(workspaces.clientId, clientId), ne(users.clientId, clientId)));
  const guestBoardsByUser = new Map<string, string[]>();
  for (const guest of guestMembers) {
    pending.push(actionRow(clientId, "guest_member_removed", { boardId: guest.boardId, userId: guest.userId, role: guest.role }));
    guestBoardsByUser.set(guest.userId, [...(guestBoardsByUser.get(guest.userId) ?? []), guest.boardId]);
  }
  for (const [userId, boardIds] of guestBoardsByUser) {
    // Downgrades must revoke the same live participation as manual guest removal: membership,
    // watchers, mentions, assignments, checklist ownership, and stale notifications all leave together.
    const cleanup = await cleanupUserBoardParticipation(tx, {
      userId,
      boardIds,
      actorId: null,
      actorKind: "system",
    });
    for (const boardId of cleanup.removedBoardIds) changes.boardMemberRemoved.push({ boardId, userId });
    changes.assigneeUpdates.push(...cleanup.assigneeUpdates);
    changes.checklistItemUpdates.push(...cleanup.checklistItemUpdates);
    changes.activities.push(...cleanup.activities);
    changes.userIdsToDisconnect.push(userId);
  }

  // Pending invitations are guest invites when their email does not belong to a member of this org
  // (email is globally unique, so a matching same-org user means an internal invite we keep).
  const pendingInvites = await tx
    .select({ id: boardInvitations.id, email: boardInvitations.email })
    .from(boardInvitations)
    .innerJoin(boards, eq(boards.id, boardInvitations.boardId))
    .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
    .where(
      and(
        eq(workspaces.clientId, clientId),
        isNull(boardInvitations.acceptedAt),
        isNull(boardInvitations.revokedAt),
        sql`not exists (select 1 from ${users} where ${users.email} = ${boardInvitations.email} and ${users.clientId} = ${clientId})`,
      ),
    );
  if (pendingInvites.length > 0) {
    const ids = pendingInvites.map((i) => i.id);
    await tx.update(boardInvitations).set({ revokedAt: new Date() }).where(inArray(boardInvitations.id, ids));
    for (const id of ids) pending.push(actionRow(clientId, "guest_invitation_revoked", { invitationId: id }));
  }

  // --- Boards: keep the oldest N live boards across every non-archived workspace in the org. ---
  const liveBoards = await tx
    .select({ id: boards.id, workspaceId: boards.workspaceId })
    .from(boards)
    .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
    .where(and(eq(workspaces.clientId, clientId), isNull(workspaces.archivedAt), isNull(boards.archivedAt)))
    .orderBy(asc(boards.createdAt));
  const boardsToArchive = liveBoards.slice(config.HOSTED_FREE_MAX_BOARDS);
  const boardIdsToArchive = boardsToArchive.map((b) => b.id);
  if (boardIdsToArchive.length > 0) {
    await tx.update(boards).set({ archivedAt: new Date(), updatedAt: new Date() }).where(inArray(boards.id, boardIdsToArchive));
    for (const board of boardsToArchive) {
      pending.push(actionRow(clientId, "board_archived", { boardId: board.id }));
      changes.boardsDeleted.push({ workspaceId: board.workspaceId, boardId: board.id });
    }
  }

  // --- Members: suspend the newest members beyond the cap, but always keep one org owner active. ---
  const members = await tx
    .select({ id: users.id, role: users.clientRole, createdAt: users.createdAt })
    .from(users)
    .where(and(eq(users.clientId, clientId), isNull(users.suspendedAt), isNull(users.removedAt)))
    .orderBy(asc(users.createdAt));
  const owners = members.filter((m) => m.role === "owner");
  const protectedOwnerId = owners[0]?.id ?? null;
  const candidates = members.filter((m) => m.id !== protectedOwnerId);
  // One owner is the lockout guard; any additional owners compete for the remaining free slots by age.
  const candidateKeepSlots = Math.max(0, config.HOSTED_FREE_MAX_ORG_MEMBERS - (protectedOwnerId ? 1 : 0));
  const membersToSuspend = candidates.slice(candidateKeepSlots).map((m) => m.id);
  if (membersToSuspend.length > 0) {
    await tx.update(users).set({ suspendedAt: new Date(), updatedAt: new Date() }).where(inArray(users.id, membersToSuspend));
    for (const id of membersToSuspend) pending.push(actionRow(clientId, "user_suspended", { userId: id }));
    changes.userIdsToDisconnect.push(...membersToSuspend);
  }

  if (pending.length > 0) await tx.insert(planActions).values(pending);
  return changes;
}

/**
 * Reverses every reversible action a prior downgrade recorded.
 * Workspaces are un-archived before boards so a board never becomes visible inside a still-archived
 * workspace. Removed guest memberships are re-inserted (skipping any whose board or user has since
 * been deleted). Processed rows are then cleared so a future downgrade starts from a clean slate.
 */
async function restoreFromPlanActions(clientId: string, tx: Tx): Promise<void> {
  const actions = await tx.select().from(planActions).where(eq(planActions.clientId, clientId));
  if (actions.length === 0) {
    // Defensive: nothing recorded, but make sure no stray suspension lingers from older data.
    await tx
      .update(users)
      .set({ suspendedAt: null, updatedAt: new Date() })
      .where(and(eq(users.clientId, clientId), sql`${users.suspendedAt} is not null`, isNull(users.removedAt)));
    return;
  }

  const idsFor = (kind: string, key: string): string[] =>
    actions.filter((a) => a.kind === kind).map((a) => (a.payload as Record<string, string>)[key] as string);

  const workspaceIds = idsFor("workspace_archived", "workspaceId");
  if (workspaceIds.length > 0) {
    await tx.update(workspaces).set({ archivedAt: null, updatedAt: new Date() }).where(inArray(workspaces.id, workspaceIds));
  }
  const boardIds = idsFor("board_archived", "boardId");
  if (boardIds.length > 0) {
    await tx.update(boards).set({ archivedAt: null, updatedAt: new Date() }).where(inArray(boards.id, boardIds));
  }
  const automationIds = idsFor("automation_disabled", "automationId");
  if (automationIds.length > 0) {
    await tx.update(automations).set({ enabled: true, updatedAt: new Date() }).where(inArray(automations.id, automationIds));
  }
  const webhookIds = idsFor("webhook_disabled", "webhookId");
  if (webhookIds.length > 0) {
    await tx.update(webhookEndpoints).set({ enabled: true, updatedAt: new Date() }).where(inArray(webhookEndpoints.id, webhookIds));
  }
  const apiKeyIds = idsFor("api_key_revoked", "apiKeyId");
  if (apiKeyIds.length > 0) {
    await tx.update(workspaceApiKeys).set({ revokedAt: null, updatedAt: new Date() }).where(inArray(workspaceApiKeys.id, apiKeyIds));
  }
  const userIds = idsFor("user_suspended", "userId");
  if (userIds.length > 0) {
    await tx.update(users).set({ suspendedAt: null, updatedAt: new Date() }).where(and(inArray(users.id, userIds), isNull(users.removedAt)));
  }
  const invitationIds = idsFor("guest_invitation_revoked", "invitationId");
  if (invitationIds.length > 0) {
    // Only re-open invites that have not since expired; expired ones stay revoked.
    await tx
      .update(boardInvitations)
      .set({ revokedAt: null })
      .where(and(inArray(boardInvitations.id, invitationIds), or(isNull(boardInvitations.expiresAt), sql`${boardInvitations.expiresAt} > now()`)));
  }
  const guestSeatUserIds = idsFor("guest_seat_removed", "userId");
  if (guestSeatUserIds.length > 0) {
    const userSet = new Set((await tx.select({ id: users.id }).from(users).where(inArray(users.id, guestSeatUserIds))).map((u) => u.id));
    const toInsert = guestSeatUserIds
      .filter((userId) => userSet.has(userId))
      .map((userId) => ({ clientId, userId, createdById: null }));
    if (toInsert.length > 0) await tx.insert(clientGuestSeats).values(toInsert).onConflictDoNothing();
  }

  // Re-insert removed guest memberships, skipping any whose board or user no longer exists.
  const guestRows = actions.filter((a) => a.kind === "guest_member_removed").map((a) => a.payload as { boardId: string; userId: string; role: string });
  if (guestRows.length > 0) {
    const boardSet = new Set((await tx.select({ id: boards.id }).from(boards).where(inArray(boards.id, guestRows.map((g) => g.boardId)))).map((b) => b.id));
    const userSet = new Set((await tx.select({ id: users.id }).from(users).where(inArray(users.id, guestRows.map((g) => g.userId)))).map((u) => u.id));
    const toInsert = guestRows
      .filter((g) => boardSet.has(g.boardId) && userSet.has(g.userId))
      .map((g) => ({ boardId: g.boardId, userId: g.userId, role: g.role as (typeof boardMembers.$inferInsert)["role"] }));
    if (toInsert.length > 0) await tx.insert(boardMembers).values(toInsert).onConflictDoNothing();
  }

  await tx.delete(planActions).where(eq(planActions.clientId, clientId));
}

/**
 * When a free org deletes a live board, refill the freed slot with the oldest board that a prior
 * downgrade archived. User-archived/deleted boards are not touched because only plan_action rows are
 * eligible, and restored rows are removed from the action log so future upgrades do not double-restore.
 */
export async function reactivatePlanArchivedBoardsIfRoom(
  clientId: string,
  tx?: Tx,
  config: PlanConversionEnv = env,
): Promise<ReactivatedPlanBoard[]> {
  if (tx) return reactivatePlanArchivedBoardsIfRoomTx(clientId, tx, config);
  return db.transaction((t) => reactivatePlanArchivedBoardsIfRoomTx(clientId, t, config));
}

async function reactivatePlanArchivedBoardsIfRoomTx(
  clientId: string,
  tx: Tx,
  config: PlanConversionEnv,
): Promise<ReactivatedPlanBoard[]> {
  if (config.KANERA_DEPLOYMENT_MODE !== "hosted") return [];
  const [client] = await tx.select({ billingStatus: clients.billingStatus }).from(clients).where(eq(clients.id, clientId)).limit(1);
  if (!client || isPaidTier(client.billingStatus)) return [];

  const [live] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(boards)
    .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
    .where(and(eq(workspaces.clientId, clientId), isNull(workspaces.archivedAt), isNull(boards.archivedAt)));
  const slots = Math.max(0, config.HOSTED_FREE_MAX_BOARDS - (live?.count ?? 0));
  if (slots === 0) return [];

  const actions = await tx
    .select({
      actionId: planActions.id,
      board: boards,
    })
    .from(planActions)
    .innerJoin(boards, eq(boards.id, sql<string>`(${planActions.payload}->>'boardId')::uuid`))
    .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
    .where(and(
      eq(planActions.clientId, clientId),
      eq(planActions.kind, "board_archived"),
      eq(workspaces.clientId, clientId),
      isNull(workspaces.archivedAt),
      sql`${boards.archivedAt} is not null`,
    ))
    .orderBy(asc(boards.createdAt))
    .limit(slots);
  if (actions.length === 0) return [];

  const boardIds = actions.map((action) => action.board.id);
  const now = new Date();
  const restored = await tx
    .update(boards)
    .set({ archivedAt: null, updatedAt: now })
    .where(inArray(boards.id, boardIds))
    .returning();
  await tx.delete(planActions).where(inArray(planActions.id, actions.map((action) => action.actionId)));
  return restored;
}
