import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from "@angular/core";
import { disabled, form, FormField, submit, validate } from "@angular/forms/signals";
import { Router, RouterLink } from "@angular/router";
import { AuthService } from "../../core/auth/auth.service";
import { PublicAuthClient } from "../../core/auth/public-auth.client";
import { LogoComponent } from "../../shared/logo.component";
import { mfaQrDataUrl } from "../../shared/mfa-qr";

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
    analyticsExcluded?: boolean;
  };
}

type KaneraEnvironment = "development" | "test" | "staging" | "production";

interface AuthConfigResponse {
  kaneraEnvironment: KaneraEnvironment;
}

@Component({
  selector: "k-login",
  standalone: true,
  imports: [RouterLink, LogoComponent, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./login.page.html",
  styleUrl: "./login.page.scss",
})
export class LoginPage {
  private readonly auth = inject(AuthService);
  private readonly publicAuth = inject(PublicAuthClient);
  private readonly router = inject(Router);

  readonly showPassword = signal(false);
  readonly challengeToken = signal("");
  readonly mfaEnrollment = signal(false);
  readonly mfaSecret = signal("");
  readonly mfaQrUrl = signal("");
  readonly recoveryCodes = signal<string[]>([]);
  readonly mfaModel = signal({ code: "" });
  readonly mfaForm = form(this.mfaModel, (verification) => {
    validate(verification.code, ({ value }) => {
      const code = value().trim();
      const message = this.mfaEnrollment()
        ? (/^\d{6}$/.test(code) ? null : "Enter the six-digit code from your authenticator app.")
        : validateRequired(code, "Authenticator or recovery code");
      return validationError(message);
    });
    disabled(verification.code, { when: ({ state }) => state.submitting() });
  });
  readonly mfaCode = this.mfaForm.code().value;
  readonly loginModel = signal({ email: "", password: "" });
  readonly loginForm = form(this.loginModel, (credentials) => {
    validate(credentials.email, ({ value }) => validationError(validateEmail(value().trim())));
    validate(credentials.password, ({ value }) => validationError(validateRequired(value(), "Password")));
    disabled(credentials.email, { when: ({ state }) => state.submitting() });
    disabled(credentials.password, { when: ({ state }) => state.submitting() });
  });
  readonly email = this.loginForm.email().value;
  readonly password = this.loginForm.password().value;
  private readonly workflowBusy = signal(false);
  private readonly workflowError = signal<string | null>(null);
  readonly busy = computed(() => this.loginForm().submitting() || this.mfaForm().submitting() || this.workflowBusy());
  readonly error = computed(() => this.workflowError() ?? (
    this.challengeToken() ? touchedFormError(this.mfaForm) : touchedFormError(this.loginForm)
  ));
  readonly kaneraEnvironment = signal<KaneraEnvironment>("production");
  readonly returnUrl = input<string>();
  readonly environmentBannerLabel = computed(() => environmentBannerLabel(this.kaneraEnvironment()));

  constructor() {
    void this.publicAuth.get("/auth/config")
      .then(async (res) => (res.ok ? parseAuthConfigResponse(await res.json()) : { kaneraEnvironment: "production" as const }))
      .then((config) => this.kaneraEnvironment.set(config.kaneraEnvironment))
      .catch(() => this.kaneraEnvironment.set("production"));
  }

  async submit(e: Event) {
    e.preventDefault();
    if (this.recoveryCodes().length) { await this.acknowledgeRequiredMfa(); return; }
    if (this.challengeToken()) {
      this.workflowError.set(null);
      await submit(this.mfaForm, async () => {
        await (this.mfaEnrollment() ? this.confirmRequiredMfa() : this.submitMfa());
        return undefined;
      });
      return;
    }
    this.workflowError.set(null);
    await submit(this.loginForm, async () => {
      let res: Response;
      try {
        res = await this.publicAuth.post("/auth/login", {
          email: this.email().trim(),
          password: this.password(),
        });
      } catch {
        return { kind: "network", message: "Unable to reach the server. Check your connection and try again." };
      }

      if (!res.ok) {
        return { kind: "credentials", message: "Invalid credentials" };
      }
      const raw = await res.json() as { status?: string; challengeToken?: string };
      if (raw.status === "mfa_required" && typeof raw.challengeToken === "string") {
        this.challengeToken.set(raw.challengeToken);
        return undefined;
      }
      if (raw.status === "mfa_enrollment_required" && typeof raw.challengeToken === "string") {
        this.challengeToken.set(raw.challengeToken);
        this.mfaEnrollment.set(true);
        const setup = await this.authPost<{ secret: string; otpauthUri: string }>("/auth/mfa/required/enroll", { challengeToken: raw.challengeToken });
        this.mfaSecret.set(setup.secret);
        this.mfaQrUrl.set(mfaQrDataUrl(setup.otpauthUri));
        return undefined;
      }
      const json = parseAuthResponse(raw);
      this.auth.setSession(json.accessToken, json.user);
      await this.router.navigateByUrl(this.safeReturnUrl());
      return undefined;
    });
  }

  private async submitMfa() {
    this.workflowBusy.set(true);
    this.workflowError.set(null);
    try {
      const res = await this.publicAuth.post("/auth/mfa/verify", { challengeToken: this.challengeToken(), code: this.mfaCode() });
      if (!res.ok) { this.workflowError.set("Invalid or expired verification code"); return; }
      const json = parseAuthResponse(await res.json());
      this.auth.setSession(json.accessToken, json.user);
      await this.router.navigateByUrl(this.safeReturnUrl());
    } finally { this.workflowBusy.set(false); }
  }

  private async confirmRequiredMfa() {
    this.workflowBusy.set(true); this.workflowError.set(null);
    try { const result = await this.authPost<{ recoveryCodes: string[] }>("/auth/mfa/required/enroll/confirm", { challengeToken: this.challengeToken(), code: this.mfaCode() }); this.recoveryCodes.set(result.recoveryCodes); }
    catch { this.workflowError.set("Invalid or expired verification code"); }
    finally { this.workflowBusy.set(false); }
  }

  private async acknowledgeRequiredMfa() {
    this.workflowBusy.set(true);
    try { const json = parseAuthResponse(await this.authPost("/auth/mfa/required/enroll/acknowledge", { challengeToken: this.challengeToken() })); this.auth.setSession(json.accessToken, json.user); await this.router.navigateByUrl(this.safeReturnUrl()); }
    finally { this.workflowBusy.set(false); }
  }

  private async authPost<T>(path: string, body: unknown): Promise<T> {
    const res = await this.publicAuth.post(path, body);
    if (!res.ok) throw new Error("Authentication failed");
    return res.json() as Promise<T>;
  }

  private safeReturnUrl() {
    const value = this.returnUrl();
    return value?.startsWith("/") && !value.startsWith("//") ? value : "/";
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

function validationError(message: string | null) {
  return message ? { kind: "validation", message } : undefined;
}

function touchedFormError(formTree: () => { touched(): boolean; errorSummary(): readonly { message?: string }[] }): string | null {
  return formTree().touched() ? formTree().errorSummary()[0]?.message ?? null : null;
}
