import type { ServerToClientEvents } from "@kanera/shared/events";
import { boardMembers, boards } from "@kanera/shared/schema";
import { requestContext } from "@fastify/request-context";
import { and, eq } from "drizzle-orm";
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
