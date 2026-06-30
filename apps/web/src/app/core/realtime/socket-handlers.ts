import type { ServerToClientEvents } from "@kanera/shared/events";
import type { AppSocket } from "./socket.service";

export type SocketHandlers = Partial<ServerToClientEvents>;

export function registerSocketHandlers(socket: AppSocket, handlers: SocketHandlers): () => void {
  for (const event of Object.keys(handlers) as Array<keyof ServerToClientEvents>) {
    socket.on(event, handlers[event] as never);
  }

  return () => {
    for (const event of Object.keys(handlers) as Array<keyof ServerToClientEvents>) {
      socket.off(event, handlers[event] as never);
    }
  };
}
