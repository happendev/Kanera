import { DestroyRef, Injectable, computed, effect, inject, untracked } from "@angular/core";
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
  private sessionGeneration = 0;
  private readonly sessionKey = computed(() => {
    const user = this.auth.user();
    return user ? `${user.id}:${user.activeClientId ?? user.clientId}` : null;
  });

  constructor() {
    if (typeof window === "undefined") return;

    let previousSessionKey: string | null = null;
    effect((onCleanup) => {
      const key = this.sessionKey();
      const hadSession = previousSessionKey !== null;
      previousSessionKey = key;
      this.sessionGeneration += 1;
      this.reloadInFlight = false;
      this.reloadPending = false;
      if (!key) {
        // React to the actual loss of the current session, not a delayed reload's false result.
        // A reload invalidated by logout must not later pull a visitor from signup back to login.
        if (hadSession) {
          this.sockets.disconnect();
          // Invite acceptance can deliberately clear the old session while navigating to login
          // with an MFA challenge. A second navigation would discard that one-use handoff state.
          // Reading navigation untracked keeps this effect scoped to identity changes alone.
          const navigation = untracked(this.router.currentNavigation);
          const destination = navigation ? this.router.serializeUrl(navigation.extractedUrl).split(/[?#]/, 1)[0] : null;
          if (destination !== "/login") void this.router.navigateByUrl("/login");
        }
        return;
      }
      // Logout replaces the socket. Scope listeners to the authenticated identity, rather than
      // assuming the first socket and its handlers live as long as this root service.
      onCleanup(this.attachSessionSync());
    });
    const onStorage = (event: StorageEvent) => {
      if (!this.auth.isLogoutSyncEvent(event)) return;
      this.auth.clearSession({ disableRefresh: true });
    };
    window.addEventListener("storage", onStorage);
    inject(DestroyRef).onDestroy(() => window.removeEventListener("storage", onStorage));
  }

  private attachSessionSync(): () => void {
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
    return registerSocketHandlers(socket, handlers);
  }

  private async reloadMe(): Promise<void> {
    if (this.reloadInFlight) {
      this.reloadPending = true;
      return;
    }

    this.reloadInFlight = true;
    const generation = this.sessionGeneration;
    const session = this.auth.getSessionGeneration();
    try {
      const previousClientId = this.auth.user()?.clientId;
      const ok = await this.auth.reloadMe({ refreshToken: true });
      if (ok && session === this.auth.getSessionGeneration() && previousClientId && this.auth.user()?.clientId !== previousClientId) {
        // This reload may itself install a fallback organisation and reattach the socket listeners.
        // Only an explicit replacement login invalidates its redirect, not that expected reattach.
        // Removal or suspension can repoint the default organisation. Re-enter through a top-level
        // route so no component keeps data from the organisation that just revoked access.
        await this.router.navigateByUrl(authenticatedLandingPath(this.auth.user()));
      }
    } finally {
      if (generation === this.sessionGeneration) {
        this.reloadInFlight = false;
        if (this.reloadPending) {
          this.reloadPending = false;
          void this.reloadMe();
        }
      }
    }
  }
}
