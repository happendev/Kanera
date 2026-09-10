import { Injectable, effect, inject } from "@angular/core";
import { Router } from "@angular/router";
import { SERVER_EVENTS, type ServerToClientEvents } from "@kanera/shared/events";
import { AuthService, authenticatedLandingPath } from "./auth.service";
import { registerSocketHandlers } from "../realtime/socket-handlers";
import { SocketService } from "../realtime/socket.service";

@Injectable({ providedIn: "root" })
export class AuthSyncService {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly sockets = inject(SocketService);
  private reloadInFlight = false;
  private reloadPending = false;
  private sessionSyncAttached = false;

  constructor() {
    if (typeof window === "undefined") return;

    effect(() => {
      if (!this.auth.user() || this.sessionSyncAttached) return;
      this.attachSessionSync();
    });
    window.addEventListener("storage", (event) => {
      if (!this.auth.isLogoutSyncEvent(event)) return;
      this.auth.clearSession({ disableRefresh: true });
      this.sockets.disconnect();
      void this.router.navigateByUrl("/login");
    });
  }

  private attachSessionSync(): void {
    this.sessionSyncAttached = true;
    const socket = this.sockets.connect();
    const handlers: Partial<ServerToClientEvents> = {
      [SERVER_EVENTS.CLIENT_ENTITLEMENTS_CHANGED]: ({ clientId }) => {
        if (this.auth.user()?.clientId !== clientId) return;
        void this.reloadMe();
      },
      [SERVER_EVENTS.CLIENT_USER_ADDED]: ({ user }) => {
        if (user.id === this.auth.user()?.id) void this.reloadMe();
      },
      [SERVER_EVENTS.CLIENT_USER_ROLE_CHANGED]: ({ userId }) => {
        if (userId === this.auth.user()?.id) void this.reloadMe();
      },
      [SERVER_EVENTS.CLIENT_USER_REMOVED]: ({ userId }) => {
        if (userId === this.auth.user()?.id) void this.reloadMe();
      },
      // Appearance changed on another of this user's devices. Writing it onto the cached session is
      // the whole handler: AppComponent's effect watches auth.user() and repaints through
      // ThemeService.hydrate(), the same path a fresh sign-in takes, and the cached copy keeps a
      // reload agreeing with what is on screen. Deliberately not reloadMe() — the payload already
      // carries the resulting pair, and appearance is the one session field a user can change
      // often enough for a round trip per keystroke-speed click to be worth avoiding.
      [SERVER_EVENTS.USER_APPEARANCE_UPDATED]: ({ theme, accent }) => {
        if (!this.auth.user()) return;
        this.auth.updateUser((user) => ({ ...user, theme, accent }));
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
      const previousClientId = this.auth.user()?.clientId;
      const ok = await this.auth.reloadMe({ refreshToken: true });
      if (!ok && !this.auth.user()) {
        this.sockets.disconnect();
        await this.router.navigateByUrl("/login");
      } else if (ok && previousClientId && this.auth.user()?.clientId !== previousClientId) {
        // Removal or suspension can repoint the default organisation. Re-enter through a top-level
        // route so no component keeps data from the organisation that just revoked access.
        await this.router.navigateByUrl(authenticatedLandingPath(this.auth.user()));
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
