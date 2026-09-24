import type { BrowserContext, WebSocketRoute } from "@playwright/test";

/**
 * Cuts and restores a context's realtime connection. `context.setOffline()` does not reliably close
 * an already-open WebSocket in Chromium, so a test built on it can pass while events keep flowing.
 * Routing the socket lets the test close it and refuse reconnects until it chooses to restore.
 * The web client is WebSocket-only (`transports: ["websocket"]`), so there is no polling fallback
 * that could bypass the route.
 */
export class SocketLink {
  private blocked = false;
  private readonly open = new Set<{ page: WebSocketRoute; server: WebSocketRoute }>();
  refusedAttempts = 0;

  static async install(context: BrowserContext): Promise<SocketLink> {
    const link = new SocketLink();
    await context.routeWebSocket(/\/socket\.io\//, (ws) => {
      if (link.blocked) {
        link.refusedAttempts++;
        void ws.close({ code: 4000, reason: "e2e: socket cut" });
        return;
      }
      const pair = { page: ws, server: ws.connectToServer() };
      link.open.add(pair);
      // Registering onClose disables Playwright's automatic close forwarding, so forward both ways.
      ws.onClose((code, reason) => {
        link.open.delete(pair);
        void pair.server.close({ code, reason });
      });
      pair.server.onClose((code, reason) => {
        link.open.delete(pair);
        void ws.close({ code, reason });
      });
    });
    return link;
  }

  get connectionCount() {
    return this.open.size;
  }

  async cut() {
    this.blocked = true;
    for (const pair of [...this.open]) {
      await pair.page.close({ code: 4000, reason: "e2e: socket cut" });
      await pair.server.close();
    }
    this.open.clear();
  }

  restore() {
    this.blocked = false;
  }
}
