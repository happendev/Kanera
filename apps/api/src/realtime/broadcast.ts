import type { ServerToClientEvents } from "@kanera/shared/events";
import { boardMembers, boards } from "@kanera/shared/schema";
import { requestContext } from "@fastify/request-context";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db.js";
import { maybeGetIo } from "./io.js";
import { logRealtimeEmit } from "./metrics.js";

function shouldUseOutboxOnly(): boolean {
  return requestContext.get("realtimeOutboxOnly") === true;
}

export function broadcastToBoard<E extends keyof ServerToClientEvents>(
  boardId: string,
  event: E,
  payload: Parameters<ServerToClientEvents[E]>[0],
): boolean {
  if (shouldUseOutboxOnly()) return false;
  const io = maybeGetIo();
  if (!io) return false;
  const startedAt = performance.now();
  // Typed broadcast to the board room. Socket.IO's generic typing on `.emit` is permissive
  // so we cast here once and let consumers stay strict.
  (io.to(`board:${boardId}`).emit as (e: E, a: Parameters<ServerToClientEvents[E]>[0]) => void)(event, payload);
  // Restricted members never join the unfiltered board room. Re-evaluate card visibility at
  // dispatch time (including outbox replay) and deliver only through their private user rooms.
  void broadcastToRestrictedBoardMembers(boardId, event, payload).catch(() => undefined);
  logRealtimeEmit({
    scope: "board",
    targetId: boardId,
    event,
    payload,
    durationMs: performance.now() - startedAt,
    roomSize: () => io.sockets.adapter.rooms.get(`board:${boardId}`)?.size,
  });
  return true;
}

async function broadcastToRestrictedBoardMembers<E extends keyof ServerToClientEvents>(
  boardId: string,
  event: E,
  payload: Parameters<ServerToClientEvents[E]>[0],
): Promise<void> {
  const server = maybeGetIo();
  if (!server) return;
  const members = await db.select({ userId: boardMembers.userId })
    .from(boardMembers)
    .where(and(eq(boardMembers.boardId, boardId), eq(boardMembers.assignedItemsOnly, true)));
  if (members.length === 0) return;
  const shaped = payload as { cardId?: string; card?: { id?: string } };
  const emitToRestrictedUser = (userId: string) => {
    (server.to(`user:${userId}`).emit as (name: E, value: Parameters<ServerToClientEvents[E]>[0]) => void)(event, payload);
  };
  const cardId = shaped.cardId ?? shaped.card?.id;
  if (!cardId) {
    // Card rebalance payloads contain positions for the whole board. Restricted clients do not
    // need that bulk event: the following card:moved event carries the visible card's final
    // position, and suppressing the bulk payload avoids leaking hidden card ids.
    if (String(event).startsWith("card:")) return;
    for (const member of members) emitToRestrictedUser(member.userId);
    return;
  }
  // Use the concrete event card id so PostgreSQL can use both assignment indexes.
  const visibleRows = await db.execute<{ userId: string }>(sql`
    select bm.user_id as "userId" from board_member bm
    where bm.board_id = ${boardId} and bm.assigned_items_only = true and (
      exists (select 1 from card_assignee ca where ca.card_id = ${cardId} and ca.user_id = bm.user_id)
      or exists (select 1 from card_checklist_item ci inner join card_checklist cc on cc.id = ci.checklist_id
        where cc.card_id = ${cardId} and ci.assignee_id = bm.user_id)
    )
  `);
  const visibleIds = new Set(visibleRows.rows.map((row) => row.userId));
  const visibilityChanged = event === "card:deleted" || event === "card:assignees:set" || event === "card:checklistItem:created" || event === "card:checklistItem:updated" || event === "card:checklistItem:deleted";
  for (const member of members) {
    if (visibleIds.has(member.userId)) {
      emitToRestrictedUser(member.userId);
      if (visibilityChanged) server.to(`user:${member.userId}`).emit("card:visibility:granted", { boardId, cardId });
    } else if (visibilityChanged) {
      server.to(`user:${member.userId}`).emit("card:visibility:revoked", { boardId, cardId });
    }
  }
}

export function broadcastToWorkspace<E extends keyof ServerToClientEvents>(
  workspaceId: string,
  event: E,
  payload: Parameters<ServerToClientEvents[E]>[0],
): boolean {
  if (shouldUseOutboxOnly()) return false;
  const io = maybeGetIo();
  if (!io) return false;
  const startedAt = performance.now();
  (io.to(`workspace:${workspaceId}`).emit as (e: E, a: Parameters<ServerToClientEvents[E]>[0]) => void)(event, payload);
  logRealtimeEmit({
    scope: "workspace",
    targetId: workspaceId,
    event,
    payload,
    durationMs: performance.now() - startedAt,
    roomSize: () => io.sockets.adapter.rooms.get(`workspace:${workspaceId}`)?.size,
  });
  return true;
}

export function broadcastPresenceToWorkspace(
  workspaceId: string,
  payload: Parameters<ServerToClientEvents["presence:changed"]>[0],
): boolean {
  if (shouldUseOutboxOnly()) return false;
  const io = maybeGetIo();
  if (!io) return false;
  const startedAt = performance.now();
  io.to(`workspace:${workspaceId}`).emit("presence:changed", payload);
  // Board-only guests are intentionally kept out of workspace rooms. They still
  // need avatar presence for users visible on their boards, so fan out the same
  // event to authorized board rooms without exposing workspace-scoped data.
  void broadcastPresenceToVisibleBoardRooms(workspaceId, payload).catch(() => undefined);
  logRealtimeEmit({
    scope: "workspace",
    targetId: workspaceId,
    event: "presence:changed",
    payload,
    durationMs: performance.now() - startedAt,
    roomSize: () => io.sockets.adapter.rooms.get(`workspace:${workspaceId}`)?.size,
  });
  return true;
}

async function broadcastPresenceToVisibleBoardRooms(
  workspaceId: string,
  payload: Parameters<ServerToClientEvents["presence:changed"]>[0],
): Promise<void> {
  const io = maybeGetIo();
  if (!io) return;
  // Board membership is the access model, so a user's presence is only broadcast to the rooms of
  // boards they explicitly belong to.
  const visibleBoards = await db
    .select({ boardId: boards.id })
    .from(boards)
    .innerJoin(
      boardMembers,
      and(eq(boardMembers.boardId, boards.id), eq(boardMembers.userId, payload.userId)),
    )
    .where(eq(boards.workspaceId, workspaceId));
  const boardIds = Array.from(new Set(visibleBoards.map((row) => row.boardId)));
  if (boardIds.length === 0) return;
  io.to(boardIds.map((boardId) => `board:${boardId}`)).emit("presence:changed", payload);
}

export function broadcastToClient<E extends keyof ServerToClientEvents>(
  clientId: string,
  event: E,
  payload: Parameters<ServerToClientEvents[E]>[0],
): boolean {
  if (shouldUseOutboxOnly()) return false;
  const io = maybeGetIo();
  if (!io) return false;
  const startedAt = performance.now();
  (io.to(`client:${clientId}`).emit as (e: E, a: Parameters<ServerToClientEvents[E]>[0]) => void)(event, payload);
  logRealtimeEmit({
    scope: "client",
    targetId: clientId,
    event,
    payload,
    durationMs: performance.now() - startedAt,
    // `adapter.rooms` only counts sockets local to this process; logged lazily for observability.
    roomSize: () => io.sockets.adapter.rooms.get(`client:${clientId}`)?.size,
  });
  // io.to(...).emit fans out across every process via the Socket.IO Redis adapter, so an io-bearing
  // process delivers globally even when its own room is empty (the recipient's socket may live on
  // another app/worker instance). Report dispatched=true so emit.ts does NOT also persist a direct
  // outbox row: that row would be re-broadcast by the dispatcher and double-deliver. The io-less
  // public API gets durable fanout via the `!io` early return above instead.
  return true;
}

export function broadcastToUser<E extends keyof ServerToClientEvents>(
  userId: string,
  event: E,
  payload: Parameters<ServerToClientEvents[E]>[0],
): boolean {
  if (shouldUseOutboxOnly()) return false;
  const io = maybeGetIo();
  if (!io) return false;
  const startedAt = performance.now();
  (io.to(`user:${userId}`).emit as (e: E, a: Parameters<ServerToClientEvents[E]>[0]) => void)(event, payload);
  logRealtimeEmit({
    scope: "user",
    targetId: userId,
    event,
    payload,
    durationMs: performance.now() - startedAt,
    // `adapter.rooms` only counts sockets local to this process; logged lazily for observability.
    roomSize: () => io.sockets.adapter.rooms.get(`user:${userId}`)?.size,
  });
  // See broadcastToClient: the Redis adapter makes this emit global, so report dispatched=true and
  // let the `!io` early return be the only path that persists a direct outbox row. Returning
  // roomSize>0 here would make a worker- or cross-instance emit also write a row that the dispatcher
  // re-broadcasts, double-delivering to the recipient's socket.
  return true;
}
