import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { Router, RouterLink } from "@angular/router";
import { AuthService } from "../../core/auth/auth.service";
import { environment } from "../../../environments/environment";
import { LogoComponent } from "../../shared/logo.component";

interface AuthResponse {
  accessToken: string;
  user: {
    id: string;
    clientId: string;
    email: string;
    displayName: string;
    avatarUrl: string | null;
    orgName: string;
    logoUrl: string | null;
    deploymentMode: "self_hosted" | "hosted";
    kaneraEnvironment: "development" | "test" | "staging" | "production";
    hasWorkspace: boolean;
    role: "owner" | "admin" | "member";
    timezone: string;
    storageUsage: {
      usedBytes: number;
      quotaBytes: number | null;
      remainingBytes: number | null;
      limited: boolean;
      maxFileBytes: number;
    };
  };
}

type KaneraEnvironment = "development" | "test" | "staging" | "production";

interface AuthConfigResponse {
  kaneraEnvironment: KaneraEnvironment;
}

@Component({
  selector: "k-login",
  standalone: true,
  imports: [RouterLink, LogoComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./login.page.html",
  styleUrl: "./login.page.scss",
})
export class LoginPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly email = signal("");
  readonly password = signal("");
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly showPassword = signal(false);
  readonly kaneraEnvironment = signal<KaneraEnvironment>("production");
  readonly environmentBannerLabel = computed(() => environmentBannerLabel(this.kaneraEnvironment()));

  constructor() {
    void fetch(`${environment.apiUrl}/auth/config`, { credentials: "include" })
      .then(async (res) => (res.ok ? parseAuthConfigResponse(await res.json()) : { kaneraEnvironment: "production" as const }))
      .then((config) => this.kaneraEnvironment.set(config.kaneraEnvironment))
      .catch(() => this.kaneraEnvironment.set("production"));
  }

  async submit(e: Event) {
    e.preventDefault();
    const email = this.email().trim();
    const password = this.password();

    this.error.set(validateEmail(email) ?? validateRequired(password, "Password"));
    if (this.error()) return;

    this.busy.set(true);
    try {
      let res: Response;
      try {
        res = await fetch(`${environment.apiUrl}/auth/login`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email,
            password,
          }),
        });
      } catch {
        this.error.set("Unable to reach the server. Check your connection and try again.");
        return;
      }

      if (!res.ok) {
        this.error.set("Invalid credentials");
        return;
      }
      const json = parseAuthResponse(await res.json());
      this.auth.setSession(json.accessToken, json.user);
      await this.router.navigateByUrl("/");
    } finally {
      this.busy.set(false);
    }
  }
}

function parseAuthConfigResponse(value: unknown): AuthConfigResponse {
  if (!value || typeof value !== "object") throw new Error("Invalid auth config response");
  const config = value as Partial<AuthConfigResponse>;
  if (!isKaneraEnvironment(config.kaneraEnvironment)) throw new Error("Invalid auth config response");
  return { kaneraEnvironment: config.kaneraEnvironment };
}

function isKaneraEnvironment(value: unknown): value is KaneraEnvironment {
  return value === "development" || value === "test" || value === "staging" || value === "production";
}

function environmentBannerLabel(value: KaneraEnvironment): string | null {
  if (value === "production") return null;
  return value[0]!.toLocaleUpperCase() + value.slice(1);
}

function parseAuthResponse(value: unknown): AuthResponse {
  if (!value || typeof value !== "object") throw new Error("Invalid auth response");
  const response = value as Partial<AuthResponse>;
  if (typeof response.accessToken !== "string" || !isAuthUser(response.user)) {
    throw new Error("Invalid auth response");
  }
  return { accessToken: response.accessToken, user: response.user };
}

function isAuthUser(value: unknown): value is AuthResponse["user"] {
  if (!value || typeof value !== "object") return false;
  const user = value as Partial<AuthResponse["user"]>;
  return (
    typeof user.id === "string" &&
    typeof user.clientId === "string" &&
    typeof user.email === "string" &&
    typeof user.displayName === "string" &&
    (typeof user.avatarUrl === "string" || user.avatarUrl === null) &&
    typeof user.orgName === "string" &&
    (typeof user.logoUrl === "string" || user.logoUrl === null) &&
    (user.deploymentMode === "self_hosted" || user.deploymentMode === "hosted") &&
    (user.kaneraEnvironment === "development" || user.kaneraEnvironment === "test" || user.kaneraEnvironment === "staging" || user.kaneraEnvironment === "production") &&
    typeof user.hasWorkspace === "boolean" &&
    typeof user.timezone === "string" &&
    isStorageUsage(user.storageUsage) &&
    (user.role === "owner" || user.role === "admin" || user.role === "member")
  );
}

function isStorageUsage(value: unknown): value is AuthResponse["user"]["storageUsage"] {
  if (!value || typeof value !== "object") return false;
  const usage = value as Partial<AuthResponse["user"]["storageUsage"]>;
  return (
    typeof usage.usedBytes === "number" &&
    (typeof usage.quotaBytes === "number" || usage.quotaBytes === null) &&
    (typeof usage.remainingBytes === "number" || usage.remainingBytes === null) &&
    typeof usage.limited === "boolean" &&
    typeof usage.maxFileBytes === "number"
  );
}

function validateEmail(email: string): string | null {
  if (!email) return "Email is required.";
  if (email.length > 254) return "Email must be 254 characters or fewer.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Enter a valid email address.";
  return null;
}

function validateRequired(value: string, label: string): string | null {
  return value ? null : `${label} is required.`;
}
