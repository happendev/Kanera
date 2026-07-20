import type { AfterViewInit, ElementRef, OnDestroy } from "@angular/core";
import { ChangeDetectionStrategy, Component, ViewChild, computed, inject, signal } from "@angular/core";
import { ActivatedRoute, Router, RouterLink } from "@angular/router";
import { AuthService } from "../../core/auth/auth.service";
import { environment } from "../../../environments/environment";
import { LogoComponent } from "../../shared/logo.component";
import { ThemeService } from "../../core/theme/theme.service";
import { AnalyticsService } from "../../core/analytics/analytics.service";

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
    isClientAdmin: boolean;
    boardInviteRedirect?: string | null;
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

interface InviteSummaryResponse {
  orgName: string;
  orgRole: "owner" | "admin" | "member";
  workspaces: { workspaceId: string; workspaceName: string; role: string }[];
}

interface AuthConfigResponse {
  emailVerificationEnabled: boolean;
  signupsEnabled: boolean;
  turnstileSiteKey: string | null;
  kaneraEnvironment: KaneraEnvironment;
  deploymentMode: DeploymentMode;
}

type KaneraEnvironment = "development" | "test" | "staging" | "production";
type DeploymentMode = "self_hosted" | "hosted";
const ANALYTICS_EVENT_VERSION = 1;

function analyticsCookie(name: string): string | null {
  const prefix = `${name}=`;
  const raw = document.cookie.split(";").map((entry) => entry.trim()).find((entry) => entry.startsWith(prefix));
  if (!raw) return null;
  try { return decodeURIComponent(raw.slice(prefix.length)); } catch { return null; }
}

function signupAcquisition() {
  const url = new URL(window.location.href);
  let referrer: string | null = null;
  try { referrer = document.referrer ? new URL(document.referrer).hostname : null; } catch { /* Invalid referrers are treated as direct. */ }
  return {
    source: analyticsCookie("kanera_analytics_source") || url.searchParams.get("utm_source")?.trim().slice(0, 120) || referrer || "direct",
    medium: analyticsCookie("kanera_analytics_medium") || url.searchParams.get("utm_medium")?.trim().slice(0, 120) || (referrer ? "referral" : "none"),
    campaign: analyticsCookie("kanera_analytics_campaign") || url.searchParams.get("utm_campaign")?.trim().slice(0, 120) || "none",
    landing_page: analyticsCookie("kanera_analytics_landing_page") || url.pathname,
  };
}

@Component({
  selector: "k-signup",
  standalone: true,
  imports: [RouterLink, LogoComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./signup.page.html",
  styleUrl: "./signup.page.scss",
})
export class SignupPage implements AfterViewInit, OnDestroy {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly analytics = inject(AnalyticsService);
  protected readonly theme = inject(ThemeService);

  readonly orgName = signal("Private");
  readonly displayName = signal("");
  readonly email = signal("");
  readonly password = signal("");
  readonly confirmPassword = signal("");
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly showPassword = signal(false);
  readonly showConfirmPassword = signal(false);
  readonly inviteToken = signal<string | null>(null);
  readonly boardInviteToken = signal<string | null>(null);
  readonly invite = signal<InviteSummaryResponse | null>(null);
  readonly emailVerificationEnabled = signal(false);
  readonly signupsEnabled = signal(true);
  readonly publicSignupBlocked = computed(() => !this.signupsEnabled() && !this.inviteToken());
  readonly kaneraEnvironment = signal<KaneraEnvironment>("production");
  readonly deploymentMode = signal<DeploymentMode>("self_hosted");
  readonly environmentBannerLabel = computed(() => environmentBannerLabel(this.kaneraEnvironment()));
  readonly turnstileSiteKey = signal<string | null>(null);
  readonly turnstileToken = signal<string | null>(null);
  readonly turnstileReady = signal(false);
  private turnstileElement: HTMLElement | null = null;
  private turnstileWidgetId: string | null = null;
  private viewReady = false;
  @ViewChild("turnstileContainer")
  set turnstileContainer(container: ElementRef<HTMLElement> | undefined) {
    const next = container?.nativeElement ?? null;
    if (this.turnstileElement === next) return;
    this.turnstileElement = next;
    this.turnstileWidgetId = null;
    this.loadTurnstile();
  }

  // Two-step signup: collect the form ("details"), email a code, then confirm it ("code").
  // The account is only created once the code is verified, so an unverified email never
  // produces an account.
  readonly step = signal<"details" | "code">("details");
  readonly code = signal("");
  readonly resendBusy = signal(false);
  readonly resendCooldown = signal(0);
  private resendTimer: ReturnType<typeof setInterval> | null = null;
  private registrationStartedTracked = false;

  setTheme(theme: "light" | "dark") {
    this.theme.setTheme(theme);
  }

  constructor() {
    const token = this.route.snapshot.queryParamMap.get("invite");
    if (token) {
      this.inviteToken.set(token);
      void fetch(`${environment.apiUrl}/invites/lookup?token=${encodeURIComponent(token)}`)
        .then(async (res) => (res.ok ? parseInviteSummaryResponse(await res.json()) : null))
        .then((invite) => this.invite.set(invite));
    }
    const boardToken = this.route.snapshot.queryParamMap.get("boardInviteToken");
    if (boardToken) {
      this.boardInviteToken.set(boardToken);
    }
    void fetch(`${environment.apiUrl}/auth/config`, { credentials: "include" })
      .then(async (res) => (res.ok ? parseAuthConfigResponse(await res.json()) : { emailVerificationEnabled: false, signupsEnabled: true, turnstileSiteKey: null, kaneraEnvironment: "production" as const, deploymentMode: "self_hosted" as const }))
      .then((config) => {
        this.emailVerificationEnabled.set(config.emailVerificationEnabled);
        this.signupsEnabled.set(config.signupsEnabled);
        this.turnstileSiteKey.set(config.turnstileSiteKey);
        this.kaneraEnvironment.set(config.kaneraEnvironment);
        this.deploymentMode.set(config.deploymentMode);
        this.loadTurnstile();
      })
      .catch(() => {
        this.emailVerificationEnabled.set(false);
        this.signupsEnabled.set(true);
        this.turnstileSiteKey.set(null);
        this.kaneraEnvironment.set("production");
        this.deploymentMode.set("self_hosted");
      });
  }

  // Step 1: validate the form locally, then ask the API to email a verification code.
  // Advancing to the code step only on success keeps an unverified email from ever
  // reaching account creation.
  async submit(e: Event) {
    e.preventDefault();
    if (this.publicSignupBlocked()) return;
    const orgName = this.orgName().trim();
    const displayName = this.displayName().trim();
    const email = this.email().trim();
    const password = this.password();
    const confirmPassword = this.confirmPassword();

    this.error.set(
      (!this.inviteToken() ? validateText(orgName, "Organisation name", 120) : null) ??
        validateText(displayName, "Your name", 120) ??
        validateEmail(email) ??
        validatePassword(password) ??
        validatePassword(confirmPassword, "Confirm password") ??
        (password === confirmPassword ? null : "Passwords do not match."),
    );
    if (this.error()) return;
    if (!this.ensureTurnstileSolved()) return;
    if (!this.registrationStartedTracked) {
      this.registrationStartedTracked = true;
      const marketingAlreadyTracked = document.cookie.split(";")
        .some((entry) => entry.trim() === "kanera_analytics_registration_started=1");
      if (!marketingAlreadyTracked) {
        const acquisition = signupAcquisition();
        const anonymousId = this.analytics.anonymousId();
        if (anonymousId) {
          this.analytics.track("registration_started", {
            anonymous_id: anonymousId,
            ...acquisition,
            event_version: ANALYTICS_EVENT_VERSION,
          });
        }
      }
    }

    this.busy.set(true);
    try {
      if (!this.emailVerificationEnabled()) {
        await this.createAccount();
        return;
      }
      const sent = await this.requestCode(email);
      if (!sent) return;
      this.code.set("");
      this.step.set("code");
      this.resetTurnstile();
    } finally {
      this.busy.set(false);
    }
  }

  // Step 2: create the account with the verified code. On success the response is a full
  // auth session, identical to the previous single-step signup.
  async confirm(e: Event) {
    e.preventDefault();
    if (this.publicSignupBlocked()) return;
    const code = this.code().trim();
    if (!/^\d{6}$/.test(code)) {
      this.error.set("Enter the 6-digit code from your email.");
      return;
    }
    this.error.set(null);
    if (!this.emailVerificationEnabled() && !this.ensureTurnstileSolved()) return;
    this.busy.set(true);
    try {
      await this.createAccount(code);
    } finally {
      this.busy.set(false);
    }
  }

  async resend() {
    if (this.resendBusy() || this.resendCooldown() > 0) return;
    if (this.publicSignupBlocked()) return;
    if (!this.ensureTurnstileSolved()) return;
    this.resendBusy.set(true);
    try {
      await this.requestCode(this.email().trim());
    } finally {
      this.resendBusy.set(false);
    }
  }

  back() {
    this.step.set("details");
    this.error.set(null);
  }

  // Shared by the initial send and resend. Returns true when the API accepted the request.
  // A short cooldown discourages hammering the rate-limited endpoint.
  private async requestCode(email: string): Promise<boolean> {
    this.error.set(null);
    const res = await fetch(`${environment.apiUrl}/auth/request-email-verification`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        ...(this.turnstileToken() ? { turnstileToken: this.turnstileToken() } : {}),
        ...(this.inviteToken() ? { inviteToken: this.inviteToken() } : {}),
        ...(this.boardInviteToken() ? { boardInviteToken: this.boardInviteToken() } : {}),
      }),
    });
    if (!res.ok) {
      const body: unknown = await res.json().catch(() => null);
      this.error.set(errorMessage(body) ?? "Could not send verification code");
      this.resetTurnstile();
      return false;
    }
    this.startResendCooldown();
    this.resetTurnstile();
    return true;
  }

  private async createAccount(code?: string) {
    const acquisition = signupAcquisition();
    const res = await fetch(`${environment.apiUrl}/auth/signup`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orgName: this.orgName().trim(),
        email: this.email().trim(),
        password: this.password(),
        displayName: this.displayName().trim(),
        ...(code ? { code } : {}),
        ...(this.turnstileToken() ? { turnstileToken: this.turnstileToken() } : {}),
        ...(this.inviteToken() ? { inviteToken: this.inviteToken() } : {}),
        ...(this.boardInviteToken() ? { boardInviteToken: this.boardInviteToken() } : {}),
        analyticsAttribution: {
          source: acquisition.source,
          medium: acquisition.medium,
          campaign: acquisition.campaign,
        },
      }),
    });
    if (!res.ok) {
      const body: unknown = await res.json().catch(() => null);
      const code = body && typeof body === "object" ? (body as Record<string, unknown>)["code"] : null;
      if (code === "SEAT_LIMIT_REACHED") {
        this.error.set("This organisation has no available seats. Ask an admin to purchase more seats before you can accept this invitation.");
      } else {
        this.error.set(errorMessage(body) ?? "Signup failed");
      }
      this.resetTurnstile();
      return;
    }
    this.resetTurnstile();
    const json = parseAuthResponse(await res.json());
    this.auth.setSession(json.accessToken, json.user);
    this.analytics.setSuppressed(json.user.analyticsExcluded === true);
    if (json.user.analyticsExcluded !== true) {
      this.analytics.identify({
        userId: json.user.id,
        name: json.user.displayName,
        email: json.user.email,
      });
    }
    if (json.user.boardInviteRedirect) {
      await this.router.navigateByUrl(json.user.boardInviteRedirect);
    } else {
      await this.router.navigateByUrl("/");
    }
  }

  private startResendCooldown() {
    if (this.resendTimer) clearInterval(this.resendTimer);
    this.resendCooldown.set(30);
    this.resendTimer = setInterval(() => {
      const next = this.resendCooldown() - 1;
      this.resendCooldown.set(next);
      if (next <= 0 && this.resendTimer) {
        clearInterval(this.resendTimer);
        this.resendTimer = null;
      }
    }, 1000);
  }

  ngOnDestroy() {
    if (this.resendTimer) clearInterval(this.resendTimer);
  }

  ngAfterViewInit() {
    this.viewReady = true;
    this.loadTurnstile();
  }

  private ensureTurnstileSolved(): boolean {
    if (!this.turnstileSiteKey()) return true;
    if (this.turnstileToken()) return true;
    this.error.set("Complete the security check to continue.");
    return false;
  }

  private loadTurnstile() {
    if (!this.turnstileSiteKey() || !this.viewReady) return;
    if (window.turnstile) {
      this.renderTurnstile();
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>('script[data-kanera-turnstile="true"]');
    if (existing) {
      existing.addEventListener("load", () => this.renderTurnstile(), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.dataset["kaneraTurnstile"] = "true";
    script.addEventListener("load", () => this.renderTurnstile(), { once: true });
    script.addEventListener("error", () => this.error.set("Security check could not load. Try refreshing the page."), { once: true });
    document.head.appendChild(script);
  }

  private renderTurnstile() {
    const siteKey = this.turnstileSiteKey();
    const element = this.turnstileElement;
    if (!siteKey || !element || !window.turnstile || this.turnstileWidgetId) return;
    this.turnstileWidgetId = window.turnstile.render(element, {
      sitekey: siteKey,
      callback: (token: string) => {
        this.turnstileToken.set(token);
        this.turnstileReady.set(true);
        if (this.error() === "Complete the security check to continue.") this.error.set(null);
      },
      "expired-callback": () => this.turnstileToken.set(null),
      "error-callback": () => {
        this.turnstileToken.set(null);
        this.error.set("Security check failed. Try again.");
      },
    });
  }

  private resetTurnstile() {
    this.turnstileToken.set(null);
    if (this.turnstileWidgetId && window.turnstile) {
      window.turnstile.reset(this.turnstileWidgetId);
    }
  }
}

declare global {
  interface Window {
    turnstile?: {
      render: (container: HTMLElement, options: TurnstileRenderOptions) => string;
      reset: (widgetId: string) => void;
    };
  }
}

interface TurnstileRenderOptions {
  sitekey: string;
  callback: (token: string) => void;
  "expired-callback": () => void;
  "error-callback": () => void;
}

function errorMessage(body: unknown): string | null {
  if (!body || typeof body !== "object" || !("message" in body)) return null;
  const message = body.message;
  return typeof message === "string" ? message : null;
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
    // boardInviteRedirect and isClientAdmin are optional — no strict check needed
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

function parseInviteSummaryResponse(value: unknown): InviteSummaryResponse {
  if (!value || typeof value !== "object") throw new Error("Invalid invite response");
  const invite = value as Partial<InviteSummaryResponse>;
  if (typeof invite.orgName !== "string" || typeof invite.orgRole !== "string" || !Array.isArray(invite.workspaces)) {
    throw new Error("Invalid invite response");
  }
  return {
    orgName: invite.orgName,
    orgRole: invite.orgRole as InviteSummaryResponse["orgRole"],
    workspaces: invite.workspaces as InviteSummaryResponse["workspaces"],
  };
}

function parseAuthConfigResponse(value: unknown): AuthConfigResponse {
  if (!value || typeof value !== "object") throw new Error("Invalid auth config response");
  const config = value as Partial<AuthConfigResponse>;
  if (typeof config.emailVerificationEnabled !== "boolean") throw new Error("Invalid auth config response");
  if (typeof config.signupsEnabled !== "boolean") throw new Error("Invalid auth config response");
  if (typeof config.turnstileSiteKey !== "string" && config.turnstileSiteKey !== null) throw new Error("Invalid auth config response");
  if (!isKaneraEnvironment(config.kaneraEnvironment)) throw new Error("Invalid auth config response");
  if (config.deploymentMode !== "self_hosted" && config.deploymentMode !== "hosted") throw new Error("Invalid auth config response");
  return { emailVerificationEnabled: config.emailVerificationEnabled, signupsEnabled: config.signupsEnabled, turnstileSiteKey: config.turnstileSiteKey, kaneraEnvironment: config.kaneraEnvironment, deploymentMode: config.deploymentMode };
}

function isKaneraEnvironment(value: unknown): value is KaneraEnvironment {
  return value === "development" || value === "test" || value === "staging" || value === "production";
}

function environmentBannerLabel(value: KaneraEnvironment): string | null {
  if (value === "production") return null;
  return value[0]!.toLocaleUpperCase() + value.slice(1);
}

function validateText(value: string, label: string, maxLength: number): string | null {
  if (!value) return `${label} is required.`;
  if (value.length > maxLength) return `${label} must be ${maxLength} characters or fewer.`;
  return null;
}

function validateEmail(email: string): string | null {
  if (!email) return "Email is required.";
  if (email.length > 254) return "Email must be 254 characters or fewer.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Enter a valid email address.";
  return null;
}

function validatePassword(password: string, label = "Password"): string | null {
  if (!password) return `${label} is required.`;
  if (password.length < 8) return `${label} must be at least 8 characters.`;
  if (password.length > 200) return `${label} must be 200 characters or fewer.`;
  return null;
}
