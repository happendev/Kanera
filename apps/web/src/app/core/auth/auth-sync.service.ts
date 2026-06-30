import { Injectable, effect, inject } from "@angular/core";
import { Router } from "@angular/router";
import { SERVER_EVENTS, type ServerToClientEvents } from "@kanera/shared/events";
import { AuthService } from "./auth.service";
import { registerSocketHandlers } from "../realtime/socket-handlers";
import { SocketService } from "../realtime/socket.service";

@Injectable({ providedIn: "root" })
export class AuthSyncService {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly sockets = inject(SocketService);
  private reloadInFlight = false;
  private reloadPending = false;
  private entitlementSyncAttached = false;

  constructor() {
    if (typeof window === "undefined") return;

    effect(() => {
      if (!this.auth.user() || this.entitlementSyncAttached) return;
      this.attachEntitlementSync();
    });
    window.addEventListener("storage", (event) => {
      if (!this.auth.isLogoutSyncEvent(event)) return;
      this.auth.clearSession({ disableRefresh: true });
      this.sockets.disconnect();
      void this.router.navigateByUrl("/login");
    });
  }

  private attachEntitlementSync(): void {
    this.entitlementSyncAttached = true;
    const socket = this.sockets.connect();
    const handlers: Partial<ServerToClientEvents> = {
      [SERVER_EVENTS.CLIENT_ENTITLEMENTS_CHANGED]: ({ clientId }) => {
        if (this.auth.user()?.clientId !== clientId) return;
        void this.reloadMe();
      },
    };
    registerSocketHandlers(socket, handlers);
  }

  private async reloadMe(): Promise<void> {
    if (this.reloadInFlight) {
      this.reloadPending = true;
      return;
    }

    this.reloadInFlight = true;
    try {
      const ok = await this.auth.reloadMe();
      if (!ok && !this.auth.user()) {
        this.sockets.disconnect();
        await this.router.navigateByUrl("/login");
      }
    } finally {
      this.reloadInFlight = false;
      if (this.reloadPending) {
        this.reloadPending = false;
        void this.reloadMe();
      }
    }
  }
}
