import { Injectable, computed, signal } from "@angular/core";
import { environment } from "../../../environments/environment";

export type AdminRole = "superadmin" | "staff";

export interface AdminAuthUser {
  id: string;
  email: string;
  displayName: string;
  role: AdminRole;
}

export const ADMIN_LOGOUT_SYNC_KEY = "kanera-admin-auth-logout";

// Admin session state. Mirrors the tenant AuthService but stripped of socket/offline/entitlements: the
// access token is kept in memory only (never localStorage), and silent renewal rides the httpOnly
// kanera_admin_rt cookie.
@Injectable({ providedIn: "root" })
export class AdminAuthService {
  private readonly _user = signal<AdminAuthUser | null>(null);
  private accessToken: string | null = null;
  private refreshInFlight: Promise<string | null> | null = null;
  private refreshDisabled = false;

  readonly user = this._user.asReadonly();
  readonly isAuthenticated = computed(() => this._user() !== null);
  readonly isSuperadmin = computed(() => this._user()?.role === "superadmin");

  getAccessToken(): string | null {
    return this.accessToken;
  }

  private setSession(accessToken: string, user: AdminAuthUser): void {
    this.refreshDisabled = false;
    this.accessToken = accessToken;
    this._user.set(user);
  }

  clearSession(disableRefresh = false): void {
    if (disableRefresh) this.refreshDisabled = true;
    this.accessToken = null;
    this._user.set(null);
  }

  async login(email: string, password: string): Promise<{ status: "mfa_required" | "mfa_enrollment_required"; challengeToken: string }> {
    const res = await fetch(`${environment.apiUrl}/admin/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      throw new Error(body.message ?? "Login failed");
    }
    return (await res.json()) as { status: "mfa_required" | "mfa_enrollment_required"; challengeToken: string };
  }

  async verifyMfa(challengeToken: string, code: string): Promise<void> {
    const json = await this.authPost<{ accessToken: string; admin: AdminAuthUser }>("/admin/auth/mfa/verify", { challengeToken, code });
    this.setSession(json.accessToken, json.admin);
  }

  async startMfaEnrollment(challengeToken: string): Promise<{ secret: string; otpauthUri: string }> {
    return this.authPost("/admin/auth/mfa/enroll", { challengeToken });
  }

  async confirmMfaEnrollment(challengeToken: string, code: string): Promise<string[]> {
    const json = await this.authPost<{ recoveryCodes: string[] }>("/admin/auth/mfa/enroll/confirm", { challengeToken, code });
    return json.recoveryCodes;
  }

  async acknowledgeMfaRecoveryCodes(challengeToken: string): Promise<void> {
    const json = await this.authPost<{ accessToken: string; admin: AdminAuthUser }>("/admin/auth/mfa/enroll/acknowledge", { challengeToken });
    this.setSession(json.accessToken, json.admin);
  }

  private async authPost<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${environment.apiUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify(body) });
    if (!res.ok) { const error = (await res.json().catch(() => ({}))) as { message?: string }; throw new Error(error.message ?? "Authentication failed"); }
    return res.json() as Promise<T>;
  }

  async logout(): Promise<void> {
    try {
      await fetch(`${environment.apiUrl}/admin/auth/logout`, { method: "POST", credentials: "include" });
    } finally {
      this.clearSession(true);
      if (typeof window !== "undefined") localStorage.setItem(ADMIN_LOGOUT_SYNC_KEY, String(Date.now()));
    }
  }

  // Single-flight refresh: concurrent 401s share one /admin/auth/refresh call so we never rotate the
  // refresh token twice in parallel (which would trip the reuse-theft detector and kill the session).
  async refresh(): Promise<string | null> {
    if (this.refreshDisabled) return null;
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = (async () => {
      if (this.refreshDisabled) return null;
      try {
        const res = await this.fetchRefresh();
        if (this.refreshDisabled) return null;
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) {
            this.clearSession(true);
            if (typeof window !== "undefined") localStorage.setItem(ADMIN_LOGOUT_SYNC_KEY, String(Date.now()));
          }
          return null;
        }
        const json = (await res.json()) as { accessToken: string; admin: AdminAuthUser };
        this.setSession(json.accessToken, json.admin);
        return json.accessToken;
      } catch {
        return null;
      } finally {
        this.refreshInFlight = null;
      }
    })();
    return this.refreshInFlight;
  }

  private async fetchRefresh(): Promise<Response> {
    for (;;) {
      try {
        const response = await fetch(`${environment.apiUrl}/admin/auth/refresh`, {
          method: "POST",
          credentials: "include",
        });
        // Angular's Vite proxy turns ECONNREFUSED into an HTTP 500 instead of rejecting fetch. While
        // developing, wait through that synthetic response so a forced page reload cannot become a
        // logout. Real auth failures are 401/403 and return immediately to refresh().
        if (environment.production || response.status < 500) return response;
      } catch (err) {
        if (environment.production) throw err;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    }
  }

  async hydrate(): Promise<void> {
    if (this._user()) return;
    await this.refresh();
  }
}
