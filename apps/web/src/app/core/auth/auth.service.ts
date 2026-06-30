import { Injectable, signal, computed } from "@angular/core";
import type { Entitlements } from "@kanera/shared/dto";
import { environment } from "../../../environments/environment";
import { STORAGE_KEYS } from "../browser/browser-contracts";

export type OrgRole = "owner" | "admin" | "member";
export type KaneraEnvironment = "development" | "test" | "staging" | "production";

export interface AuthUser {
  id: string;
  clientId: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  orgName: string;
  logoUrl: string | null;
  deploymentMode: "self_hosted" | "hosted";
  kaneraEnvironment?: KaneraEnvironment;
  hasWorkspace: boolean;
  role: OrgRole;
  timezone: string;
  storageUsage?: {
    usedBytes: number;
    quotaBytes: number | null;
    remainingBytes: number | null;
    limited: boolean;
    maxFileBytes: number;
  };
  entitlements?: Entitlements;
}

@Injectable({ providedIn: "root" })
export class AuthService {
  private readonly _user = signal<AuthUser | null>(null);
  private accessToken: string | null = null;
  private refreshInFlight: Promise<string | null> | null = null;
  private refreshDisabled = false;

  readonly user = this._user.asReadonly();
  readonly isAuthenticated = computed(() => this._user() !== null);
  readonly isOrgAdmin = computed(() => {
    const u = this._user();
    return u !== null && (u.role === "owner" || u.role === "admin");
  });
  readonly isOrgOwner = computed(() => this._user()?.role === "owner");

  // Plan entitlements drive UI gating; the server still enforces every limit. Defaults are
  // permissive so self-hosted and any pre-entitlements session behave as unlimited.
  readonly entitlements = computed<Entitlements | null>(() => this._user()?.entitlements ?? null);
  readonly isPlanLimited = computed(() => this.entitlements()?.limited ?? false);
  readonly guestsAllowed = computed(() => this.entitlements()?.guestsAllowed ?? true);
  readonly apiAllowed = computed(() => this.entitlements()?.apiAllowed ?? true);
  readonly webhooksAllowed = computed(() => this.entitlements()?.webhooksAllowed ?? true);
  readonly maxBoards = computed(() => this.entitlements()?.maxBoards ?? null);
  readonly maxOrgMembers = computed(() => this.entitlements()?.maxOrgMembers ?? null);
  readonly maxEnabledAutomations = computed(() => this.entitlements()?.maxEnabledAutomations ?? null);

  getAccessToken(): string | null {
    return this.accessToken;
  }

  broadcastLogout(): void {
    if (typeof window === "undefined") return;
    localStorage.setItem(STORAGE_KEYS.LOGOUT_SYNC, `${Date.now()}`);
  }

  setSession(accessToken: string, user: AuthUser): void {
    this.refreshDisabled = false;
    this.accessToken = accessToken;
    this._user.set(user);
    void this.syncTimezone(user);
  }

  updateUser(mutator: (user: AuthUser) => AuthUser): void {
    const current = this._user();
    if (current) this._user.set(mutator(current));
  }

  clearSession(options: { disableRefresh?: boolean; broadcast?: boolean } = {}): void {
    if (options.disableRefresh) this.refreshDisabled = true;
    this.accessToken = null;
    this._user.set(null);
    if (options.broadcast) this.broadcastLogout();
  }

  async refresh(): Promise<string | null> {
    if (this.refreshDisabled) return null;
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = (async () => {
      if (this.refreshDisabled) return null;
      try {
        const res = await fetch(`${environment.apiUrl}/auth/refresh`, {
          method: "POST",
          credentials: "include",
        });
        if (this.refreshDisabled) return null;
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) {
            this.clearSession({ disableRefresh: true, broadcast: true });
          }
          return null;
        }
        const json = (await res.json()) as { accessToken: string; user: AuthUser };
        this.setSession(json.accessToken, json.user);
        return json.accessToken;
      } catch {
        return null;
      } finally {
        this.refreshInFlight = null;
      }
    })();
    return this.refreshInFlight;
  }

  async hydrate(): Promise<void> {
    if (this._user()) return;
    await this.refresh();
  }

  async reloadMe(): Promise<boolean> {
    const load = async (token: string | null): Promise<Response> => {
      const headers = new Headers();
      if (token) headers.set("Authorization", `Bearer ${token}`);
      return fetch(`${environment.apiUrl}/me`, { headers, credentials: "include" });
    };

    let token = this.accessToken ?? await this.refresh();
    if (!token) return false;
    let res = await load(token);
    if (res.status === 401) {
      token = await this.refresh();
      if (!token) return false;
      res = await load(token);
    }
    if (res.status === 401) {
      this.clearSession();
      return false;
    }
    if (!res.ok) return false;

    const user = (await res.json()) as AuthUser;
    this.setSession(token, user);
    return true;
  }

  isLogoutSyncEvent(event: StorageEvent): boolean {
    return event.key === STORAGE_KEYS.LOGOUT_SYNC && event.newValue !== null;
  }

  private async syncTimezone(user: AuthUser): Promise<void> {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    if (user.timezone === timezone) return;
    try {
      const res = await fetch(`${environment.apiUrl}/auth/me`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.accessToken}`,
        },
        credentials: "include",
        body: JSON.stringify({ timezone }),
      });
      if (!res.ok) return;
      const updated = (await res.json()) as AuthUser;
      this._user.set(updated);
    } catch {
      // Timezone sync is best-effort; auth should not fail if the browser blocks it.
    }
  }
}
