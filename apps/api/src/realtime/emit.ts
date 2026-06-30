import { compactWireCard, SERVER_EVENTS, type ServerToClientEvents } from "@kanera/shared/events";
import { broadcastToBoard, broadcastToClient, broadcastToUser, broadcastToWorkspace } from "./broadcast.js";
import { logRealtimePublishFailure } from "./metrics.js";
import { publishDirectRealtimeEvent, publishRealtimeEvent } from "./outbox.js";

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
  const realtimeDispatched = broadcastToClient(clientId, event, args[0]);
  void publishDirectRealtimeEvent("client", clientId, event, args[0], { realtimeDispatched })
    .catch((err) => logRealtimePublishFailure(err, { scope: "client", scopeId: clientId, event }));
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
  const realtimeDispatched = broadcastToUser(userId, event, args[0]);
  void publishDirectRealtimeEvent("user", userId, event, args[0], { realtimeDispatched })
    .catch((err) => logRealtimePublishFailure(err, { scope: "user", scopeId: userId, event }));
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
