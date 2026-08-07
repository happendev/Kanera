import { compactWireCard, SERVER_EVENTS, type ServerToClientEvents } from "@kanera/shared/events";
import { boardMembers, boards, clientMembers, users, workspaceMembers, workspaces } from "@kanera/shared/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db.js";
import { broadcastToBoard, broadcastToClient, broadcastToUser, broadcastToWorkspace } from "./broadcast.js";
import { logRealtimePublishFailure } from "./metrics.js";
import { publishDirectRealtimeEvent, publishRealtimeEvent } from "./outbox.js";

type EventPayload<E extends keyof ServerToClientEvents> = Parameters<ServerToClientEvents[E]>[0];
type BoardLifecycleEvent =
  | typeof SERVER_EVENTS.BOARD_CREATED
  | typeof SERVER_EVENTS.BOARD_UPDATED
  | typeof SERVER_EVENTS.BOARD_MOVED
  | typeof SERVER_EVENTS.BOARD_DELETED;
type BoardRebalancedPayload = EventPayload<typeof SERVER_EVENTS.BOARD_REBALANCED>;
type UserPayload<E extends keyof ServerToClientEvents> = {
  userId: string;
  payload: EventPayload<E>;
};

function compactBoardRealtimePayload<E extends keyof ServerToClientEvents>(
  event: E,
  payload: Parameters<ServerToClientEvents[E]>[0],
): Parameters<ServerToClientEvents[E]>[0] {
  if (event !== SERVER_EVENTS.CARD_CREATED && event !== SERVER_EVENTS.CARD_UPDATED) return payload;
  const cardPayload = payload as Parameters<ServerToClientEvents[typeof SERVER_EVENTS.CARD_CREATED]>[0];
  return { ...cardPayload, card: compactWireCard(cardPayload.card) } as Parameters<ServerToClientEvents[E]>[0];
}

export function emitToBoard<E extends keyof ServerToClientEvents>(
  boardId: string,
  event: E,
  ...args: Parameters<ServerToClientEvents[E]>
) {
  const payload = compactBoardRealtimePayload(event, args[0]);
  const realtimeDispatched = broadcastToBoard(boardId, event, payload);
  return publishRealtimeEvent("board", boardId, event, payload, { realtimeDispatched })
    .catch((err) => {
      logRealtimePublishFailure(err, { scope: "board", scopeId: boardId, event });
      return null;
    });
}

export function emitToClient<E extends keyof ServerToClientEvents>(
  clientId: string,
  event: E,
  ...args: Parameters<ServerToClientEvents[E]>
): void {
  void emitToClientDurable(clientId, event, ...args);
}

export async function emitToClientDurable<E extends keyof ServerToClientEvents>(
  clientId: string,
  event: E,
  ...args: Parameters<ServerToClientEvents[E]>
): Promise<void> {
  const realtimeDispatched = broadcastToClient(clientId, event, args[0]);
  await publishDirectRealtimeEvent("client", clientId, event, args[0], { realtimeDispatched })
    .catch((err) => { logRealtimePublishFailure(err, { scope: "client", scopeId: clientId, event }); });
}

export function emitClientEntitlementsChanged(clientId: string): void {
  // Client-scoped invalidation only: sessions refresh /me for fresh entitlement UX without exposing
  // billing details or Stripe state over realtime.
  emitToClient(clientId, SERVER_EVENTS.CLIENT_ENTITLEMENTS_CHANGED, { clientId });
}

export function emitToUser<E extends keyof ServerToClientEvents>(
  userId: string,
  event: E,
  ...args: Parameters<ServerToClientEvents[E]>
): void {
  void emitToUserDurable(userId, event, ...args);
}

export async function emitToUserDurable<E extends keyof ServerToClientEvents>(
  userId: string,
  event: E,
  ...args: Parameters<ServerToClientEvents[E]>
): Promise<void> {
  const realtimeDispatched = broadcastToUser(userId, event, args[0]);
  await publishDirectRealtimeEvent("user", userId, event, args[0], { realtimeDispatched })
    .catch((err) => { logRealtimePublishFailure(err, { scope: "user", scopeId: userId, event }); });
}

async function workspaceIdForBoard(boardId: string): Promise<string | null> {
  const [board] = await db.select({ workspaceId: boards.workspaceId }).from(boards).where(eq(boards.id, boardId)).limit(1);
  return board?.workspaceId ?? null;
}

export async function boardRealtimeAudience(boardId: string): Promise<string[]> {
  const rows = await db.execute<{ userId: string }>(sql`
    select distinct "userId" from (
      select bm.user_id as "userId"
      from board_member bm
      where bm.board_id = ${boardId}
      union
      select cm.user_id as "userId"
      from board b
      inner join workspace w on w.id = b.workspace_id
      inner join client_member cm on cm.client_id = w.client_id
      inner join "user" u on u.id = cm.user_id
      where b.id = ${boardId}
        and cm.client_role in ('owner', 'admin')
        and cm.removed_at is null
        and cm.suspended_at is null
        and u.deleted_at is null
    ) audience
  `);
  return rows.rows.map((row) => row.userId);
}

export async function workspaceAdminRealtimeAudience(workspaceId: string): Promise<string[]> {
  const memberAdmins = db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .innerJoin(clientMembers, and(
      eq(clientMembers.clientId, workspaces.clientId),
      eq(clientMembers.userId, workspaceMembers.userId),
    ))
    .where(and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.role, "admin"),
      isNull(clientMembers.removedAt),
      isNull(clientMembers.suspendedAt),
      isNull(users.deletedAt),
    ));
  const orgAdmins = db
    .select({ userId: clientMembers.userId })
    .from(clientMembers)
    .innerJoin(workspaces, eq(workspaces.clientId, clientMembers.clientId))
    .where(and(
      eq(workspaces.id, workspaceId),
      inArray(clientMembers.clientRole, ["owner", "admin"]),
      isNull(clientMembers.removedAt),
      isNull(clientMembers.suspendedAt),
    ));
  const [workspaceRows, orgRows] = await Promise.all([memberAdmins, orgAdmins]);
  return Array.from(new Set([...workspaceRows, ...orgRows].map((row) => row.userId)));
}

export async function globalWorkSeparatorRealtimeAudience(workspaceId: string, targetUserId: string): Promise<string[]> {
  return Array.from(new Set([targetUserId, ...(await workspaceAdminRealtimeAudience(workspaceId))]));
}

async function emitFilteredUserPayloads<E extends keyof ServerToClientEvents>(
  scope: "workspace" | "board",
  scopeId: string,
  event: E,
  outboxPayload: EventPayload<E>,
  userPayloads: UserPayload<E>[],
) {
  const uniquePayloads = new Map<string, EventPayload<E>>();
  for (const item of userPayloads) uniquePayloads.set(item.userId, item.payload);

  // Filtered fanout is a confidentiality boundary: users receive private user-room/direct events,
  // while the durable workspace/board outbox row is retained only for webhooks and audit replay.
  const directWrites: Array<Promise<unknown>> = [];
  for (const [userId, payload] of uniquePayloads) {
    const realtimeDispatched = broadcastToUser(userId, event, payload);
    directWrites.push(
      publishDirectRealtimeEvent("user", userId, event, payload, { realtimeDispatched })
        .catch((err) => logRealtimePublishFailure(err, { scope: "user", scopeId: userId, event })),
    );
  }

  const outboxWrite = publishRealtimeEvent(scope, scopeId, event, outboxPayload, { realtimeDispatched: true })
    .catch((err) => {
      logRealtimePublishFailure(err, { scope, scopeId, event });
      return null;
    });
  await Promise.all([...directWrites, outboxWrite]);
}

/**
 * Deliver confidential board-scoped metadata through user rooms while retaining the ordinary
 * board outbox row for webhook delivery. The caller owns audience resolution.
 */
export async function emitToFilteredBoardAudience<E extends keyof ServerToClientEvents>(
  boardId: string,
  event: E,
  payload: EventPayload<E>,
  audienceUserIds: string[],
) {
  await emitFilteredUserPayloads("board", boardId, event, payload, audienceUserIds.map((userId) => ({ userId, payload })));
}

export async function emitToBoardAudience<E extends BoardLifecycleEvent>(
  boardId: string,
  event: E,
  payload: EventPayload<E>,
  options: {
    workspaceId?: string;
    audienceUserIds?: string[];
    outboxScope?: "workspace" | "board";
  } = {},
) {
  const audienceUserIds = options.audienceUserIds ?? await boardRealtimeAudience(boardId);
  const scope = options.outboxScope ?? (event === SERVER_EVENTS.BOARD_DELETED ? "workspace" : "board");
  const workspaceId = options.workspaceId ?? (scope === "workspace" ? await workspaceIdForBoard(boardId) : null);
  const scopeId = scope === "board" ? boardId : workspaceId;
  if (!scopeId) return;
  await emitFilteredUserPayloads(scope, scopeId, event, payload, audienceUserIds.map((userId) => ({ userId, payload })));
}

export async function emitBoardRebalancedToVisibleUsers(
  workspaceId: string,
  payload: BoardRebalancedPayload,
) {
  const boardIds = payload.positions.map((position) => position.id);
  const [adminUserIds, memberRows] = await Promise.all([
    workspaceAdminRealtimeAudience(workspaceId),
    boardIds.length === 0
      ? Promise.resolve([])
      : db
        .select({ boardId: boardMembers.boardId, userId: boardMembers.userId })
        .from(boardMembers)
        .where(inArray(boardMembers.boardId, boardIds)),
  ]);
  const adminSet = new Set(adminUserIds);
  const positionsByBoard = new Map(payload.positions.map((position) => [position.id, position]));
  const visibleBoardIdsByUser = new Map<string, Set<string>>();
  for (const row of memberRows) {
    if (adminSet.has(row.userId)) continue;
    const visible = visibleBoardIdsByUser.get(row.userId) ?? new Set<string>();
    visible.add(row.boardId);
    visibleBoardIdsByUser.set(row.userId, visible);
  }

  const userPayloads: UserPayload<typeof SERVER_EVENTS.BOARD_REBALANCED>[] = adminUserIds.map((userId) => ({ userId, payload }));
  for (const [userId, visibleBoardIds] of visibleBoardIdsByUser) {
    const positions = [...visibleBoardIds].flatMap((boardId) => {
      const position = positionsByBoard.get(boardId);
      return position ? [position] : [];
    });
    if (positions.length > 0) userPayloads.push({ userId, payload: { ...payload, positions } });
  }

  await emitFilteredUserPayloads("workspace", workspaceId, SERVER_EVENTS.BOARD_REBALANCED, payload, userPayloads);
}

export async function emitToWorkspaceAdmins<E extends keyof ServerToClientEvents>(
  workspaceId: string,
  event: E,
  payload: EventPayload<E>,
) {
  const audienceUserIds = await workspaceAdminRealtimeAudience(workspaceId);
  await emitFilteredUserPayloads("workspace", workspaceId, event, payload, audienceUserIds.map((userId) => ({ userId, payload })));
}

export async function emitToGlobalWorkSeparatorAudience<E extends keyof ServerToClientEvents>(
  workspaceId: string,
  targetUserId: string,
  event: E,
  payload: EventPayload<E>,
) {
  const audienceUserIds = await globalWorkSeparatorRealtimeAudience(workspaceId, targetUserId);
  // Global Work separators are personal app layout, not workspace data or a public webhook surface.
  // Durable direct-user events keep every eligible session convergent without publishing them into
  // the workspace outbox consumed by public integrations.
  await Promise.all(audienceUserIds.map((userId) =>
    emitToUserDurable(userId, event, ...([payload] as Parameters<ServerToClientEvents[E]>))
  ));
}

/**
 * Tell everyone who might be looking at one person's priority queue to refetch it.
 *
 * Carries `targetUserId` and nothing else. The queue is an access-filtered projection — a workspace
 * admin and the target legitimately see different slices of the *same* queue — and this audience is
 * deliberately over-broad (every admin of every workspace the target belongs to, whether or not
 * they are looking at this person). One content payload across that mixed audience would leak card
 * identity across a tenancy boundary, so each client refetches under its own credentials instead.
 *
 * The audience is derived from the *target's workspace memberships*, not from the workspaces of the
 * cards currently queued: the read gate (`reorderableWorkspaceIds`) admits any admin of a workspace
 * the target is a member of, whatever the queue holds — an admin watching an empty or wholly
 * foreign-workspace queue is still a reader whose ranks and `hiddenCount` just changed. Memberships
 * are also stable across a queue mutation, so no before/after union is needed here; callers fire
 * one ping after commit.
 *
 * Direct-user outbox, never the workspace outbox: publishing an `event_outbox` row would push a
 * named person's cross-workspace priority list to every workspace webhook subscriber, and the queue
 * spans workspaces so `publishRealtimeEvent("workspace", scopeId, …)` has no well-defined scopeId —
 * any choice delivers to the wrong subscribers.
 */
export async function emitCardPriorityInvalidated(targetUserId: string): Promise<void> {
  const membershipRows = await db
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, targetUserId));
  const adminAudiences = await Promise.all(
    membershipRows.map((row) => workspaceAdminRealtimeAudience(row.workspaceId)),
  );
  const audienceUserIds = new Set([targetUserId, ...adminAudiences.flat()]);
  await Promise.all([...audienceUserIds].map((userId) =>
    emitToUserDurable(userId, SERVER_EVENTS.CARD_PRIORITY_INVALIDATED, { targetUserId })
  ));
}

export function emitToWorkspace<E extends keyof ServerToClientEvents>(
  workspaceId: string,
  event: E,
  ...args: Parameters<ServerToClientEvents[E]>
) {
  const realtimeDispatched = broadcastToWorkspace(workspaceId, event, args[0]);
  return publishRealtimeEvent("workspace", workspaceId, event, args[0], { realtimeDispatched })
    .catch((err) => {
      logRealtimePublishFailure(err, { scope: "workspace", scopeId: workspaceId, event });
      return null;
    });
}

export { broadcastToBoard, broadcastToWorkspace };
