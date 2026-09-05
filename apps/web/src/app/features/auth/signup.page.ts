import type { AfterViewInit, ElementRef, OnDestroy, OnInit } from "@angular/core";
import { ChangeDetectionStrategy, Component, ViewChild, computed, inject, signal } from "@angular/core";
import { disabled, form, FormField, submit, validate } from "@angular/forms/signals";
import { ActivatedRoute, Router, RouterLink } from "@angular/router";
import type { BoardInvitationLookupResponse } from "@kanera/shared/dto";
import { AuthService } from "../../core/auth/auth.service";
import { PublicAuthClient } from "../../core/auth/public-auth.client";
import { TurnstileChallenge } from "../../core/auth/turnstile-challenge";
import { parseAuthResponse } from "../../core/auth/auth-response";
import { LogoComponent } from "../../shared/logo.component";
import { ThemeService } from "../../core/theme/theme.service";
import { AnalyticsService } from "../../core/analytics/analytics.service";

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
  imports: [RouterLink, LogoComponent, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./signup.page.html",
  styleUrl: "./signup.page.scss",
})
export class SignupPage implements AfterViewInit, OnDestroy, OnInit {
  private readonly auth = inject(AuthService);
  private readonly publicAuth = inject(PublicAuthClient);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly analytics = inject(AnalyticsService);
  protected readonly theme = inject(ThemeService);

  readonly inviteToken = signal<string | null>(null);
  readonly boardInviteToken = signal<string | null>(null);
  readonly signupModel = signal({
    orgName: "Private",
    displayName: "",
    email: "",
    password: "",
    confirmPassword: "",
  });
  readonly signupForm = form(this.signupModel, (signup) => {
    validate(signup.orgName, ({ value }) => validationError(
      this.inviteToken() || this.boardInviteToken() ? null : validateText(value().trim(), "Organisation name", 120),
    ));
    validate(signup.displayName, ({ value }) => validationError(validateText(value().trim(), "Your name", 120)));
    validate(signup.email, ({ value }) => validationError(validateEmail(value().trim())));
    validate(signup.password, ({ value }) => validationError(validatePassword(value())));
    validate(signup.confirmPassword, (context) => {
      const message = validatePassword(context.value(), "Confirm password")
        ?? (context.value() === context.valueOf(signup.password) ? null : "Passwords do not match.");
      return validationError(message);
    });
    disabled(signup.orgName, { when: ({ state }) => state.submitting() });
    disabled(signup.displayName, { when: ({ state }) => state.submitting() });
    disabled(signup.email, { when: ({ state }) => state.submitting() });
    disabled(signup.password, { when: ({ state }) => state.submitting() });
    disabled(signup.confirmPassword, { when: ({ state }) => state.submitting() });
  });
  readonly verificationModel = signal({ code: "" });
  readonly verificationForm = form(this.verificationModel, (verification) => {
    validate(verification.code, ({ value }) => validationError(
      /^\d{6}$/.test(value().trim()) ? null : "Enter the 6-digit code from your email.",
    ));
    disabled(verification.code, { when: ({ state }) => state.submitting() });
  });
  readonly orgName = this.signupForm.orgName().value;
  readonly displayName = this.signupForm.displayName().value;
  readonly email = this.signupForm.email().value;
  readonly password = this.signupForm.password().value;
  readonly confirmPassword = this.signupForm.confirmPassword().value;
  readonly code = this.verificationForm.code().value;
  private readonly workflowError = signal<string | null>(null);
  readonly error = computed(() => this.workflowError() ?? (
    this.step() === "code" ? touchedFormError(this.verificationForm) : touchedFormError(this.signupForm)
  ));
  readonly busy = computed(() => this.signupForm().submitting() || this.verificationForm().submitting());
  readonly showPassword = signal(false);
  readonly showConfirmPassword = signal(false);
  readonly invite = signal<InviteSummaryResponse | null>(null);
  readonly boardInvite = signal<BoardInvitationLookupResponse | null>(null);
  readonly boardInviteNotice = signal<string | null>(null);
  readonly emailVerificationEnabled = signal(false);
  readonly signupsEnabled = signal(true);
  readonly publicSignupBlocked = computed(() => !this.signupsEnabled() && !this.inviteToken() && !this.boardInviteToken());
  readonly signInLink = computed(() => {
    const token = this.boardInviteToken();
    if (!token) return "/login";
    const returnUrl = `/board-invite?token=${encodeURIComponent(token)}`;
    return `/login?returnUrl=${encodeURIComponent(returnUrl)}`;
  });
  readonly kaneraEnvironment = signal<KaneraEnvironment>("production");
  readonly deploymentMode = signal<DeploymentMode>("self_hosted");
  readonly environmentBannerLabel = computed(() => environmentBannerLabel(this.kaneraEnvironment()));
  readonly turnstileReady = signal(false);
  private readonly turnstile = new TurnstileChallenge(this.workflowError, () => this.turnstileReady.set(true));
  readonly turnstileSiteKey = this.turnstile.siteKey;
  readonly turnstileToken = this.turnstile.token;
  @ViewChild("turnstileContainer")
  set turnstileContainer(container: ElementRef<HTMLElement> | undefined) {
    this.turnstile.setElement(container?.nativeElement ?? null);
  }

  // Two-step signup: collect the form ("details"), email a code, then confirm it ("code").
  // The account is only created once the code is verified, so an unverified email never
  // produces an account.
  readonly step = signal<"details" | "code">("details");
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
      void this.publicAuth.get(`/invites/lookup?token=${encodeURIComponent(token)}`)
        .then(async (res) => (res.ok ? parseInviteSummaryResponse(await res.json()) : null))
        .then((invite) => this.invite.set(invite));
    }
    const boardToken = this.route.snapshot.queryParamMap.get("boardInviteToken");
    if (boardToken) {
      this.boardInviteToken.set(boardToken);
    }
    void this.publicAuth.get("/auth/config")
      .then(async (res) => (res.ok ? parseAuthConfigResponse(await res.json()) : { emailVerificationEnabled: false, signupsEnabled: true, turnstileSiteKey: null, kaneraEnvironment: "production" as const, deploymentMode: "self_hosted" as const }))
      .then((config) => {
        this.emailVerificationEnabled.set(config.emailVerificationEnabled);
        this.signupsEnabled.set(config.signupsEnabled);
        this.turnstileSiteKey.set(config.turnstileSiteKey);
        this.kaneraEnvironment.set(config.kaneraEnvironment);
        this.deploymentMode.set(config.deploymentMode);
        this.turnstile.load();
      })
      .catch(() => {
        this.emailVerificationEnabled.set(false);
        this.signupsEnabled.set(true);
        this.turnstileSiteKey.set(null);
        this.kaneraEnvironment.set("production");
        this.deploymentMode.set("self_hosted");
      });
  }

  async ngOnInit(): Promise<void> {
    const token = this.boardInviteToken();
    if (!token) return;
    try {
      const res = await this.publicAuth.get(`/board-invitations/lookup?token=${encodeURIComponent(token)}`);
      if (res.status === 404) {
        // Only an authoritative "this invitation does not exist / has expired" drops the token.
        this.boardInviteToken.set(null);
        this.boardInviteNotice.set("We couldn’t load that board invitation — it may have been revoked or expired. You can still create a regular account below.");
        return;
      }
      if (!res.ok) throw new Error("lookup failed");
      const invitation = parseBoardInviteSummaryResponse(await res.json());
      this.boardInvite.set(invitation);
      // The invite token was delivered to this mailbox, and the API rejects any mismatch. Locking
      // the prefilled value prevents the most common accidental path into a disconnected account.
      this.email.set(invitation.email);
    } catch {
      // A transient failure (network blip, lookup rate limit, response-shape skew during a rolling
      // deploy) must NOT discard the token: signup still carries it, and the API enforces the
      // invited-email match with a clear error. Only the banner and prefill degrade.
      this.boardInviteNotice.set("We couldn’t load the invitation details right now. Sign up with the invited email address and your board access will still be connected.");
    }
  }

  // Step 1: validate the form locally, then ask the API to email a verification code.
  // Advancing to the code step only on success keeps an unverified email from ever
  // reaching account creation.
  submit(e: Event) {
    e.preventDefault();
    if (this.publicSignupBlocked()) return;
    this.workflowError.set(null);
    return submit(this.signupForm, async () => {
      if (!this.turnstile.ensureSolved()) return undefined;
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
      if (!this.emailVerificationEnabled()) {
        await this.createAccount();
        return undefined;
      }
      const sent = await this.requestCode(this.email().trim());
      if (!sent) return undefined;
      this.verificationForm().reset({ code: "" });
      this.step.set("code");
      this.turnstile.reset();
      return undefined;
    });
  }

  // Step 2: create the account with the verified code. On success the response is a full
  // auth session, identical to the previous single-step signup.
  confirm(e: Event) {
    e.preventDefault();
    if (this.publicSignupBlocked()) return;
    this.workflowError.set(null);
    return submit(this.verificationForm, async () => {
      if (!this.emailVerificationEnabled() && !this.turnstile.ensureSolved()) return undefined;
      await this.createAccount(this.code().trim());
      return undefined;
    });
  }

  async resend() {
    if (this.resendBusy() || this.resendCooldown() > 0) return;
    if (this.publicSignupBlocked()) return;
    if (!this.turnstile.ensureSolved()) return;
    this.resendBusy.set(true);
    try {
      await this.requestCode(this.email().trim());
    } finally {
      this.resendBusy.set(false);
    }
  }

  back() {
    this.step.set("details");
    this.workflowError.set(null);
    this.verificationForm().reset();
  }

  // Shared by the initial send and resend. Returns true when the API accepted the request.
  // A short cooldown discourages hammering the rate-limited endpoint.
  private async requestCode(email: string): Promise<boolean> {
    this.workflowError.set(null);
    const res = await this.publicAuth.post("/auth/request-email-verification", {
      email,
      ...(this.turnstileToken() ? { turnstileToken: this.turnstileToken() } : {}),
      ...(this.inviteToken() ? { inviteToken: this.inviteToken() } : {}),
      ...(this.boardInviteToken() ? { boardInviteToken: this.boardInviteToken() } : {}),
    });
    if (!res.ok) {
      const body: unknown = await res.json().catch(() => null);
      if (await this.redirectExistingInviteAccount(body)) return false;
      this.workflowError.set(errorMessage(body) ?? "Could not send verification code");
      this.turnstile.reset();
      return false;
    }
    this.startResendCooldown();
    this.turnstile.reset();
    return true;
  }

  private async createAccount(code?: string) {
    const acquisition = signupAcquisition();
    const res = await this.publicAuth.post("/auth/signup", {
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
    });
    if (!res.ok) {
      const body: unknown = await res.json().catch(() => null);
      const code = body && typeof body === "object" ? (body as Record<string, unknown>)["code"] : null;
      if (await this.redirectExistingInviteAccount(body)) {
        this.turnstile.reset();
        return;
      } else if (code === "SEAT_LIMIT_REACHED") {
        this.workflowError.set("This organisation has no available seats. Ask an admin to purchase more seats before you can accept this invitation.");
      } else {
        this.workflowError.set(errorMessage(body) ?? "Signup failed");
      }
      this.turnstile.reset();
      return;
    }
    this.turnstile.reset();
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

  private async redirectExistingInviteAccount(body: unknown): Promise<boolean> {
    const code = body && typeof body === "object" ? (body as Record<string, unknown>)["code"] : null;
    if (code !== "ACCOUNT_EXISTS") return false;
    const boardToken = this.boardInviteToken();
    if (boardToken) {
      const returnUrl = `/board-invite?token=${encodeURIComponent(boardToken)}`;
      await this.router.navigateByUrl(`/login?returnUrl=${encodeURIComponent(returnUrl)}`);
      return true;
    }
    const token = this.inviteToken();
    if (!token) return false;
    // Existing identities accept org invites through the authenticated invite flow. Keeping the
    // token in the URL also lets that page send a signed-out visitor through login and back again.
    await this.router.navigateByUrl(`/invite?token=${encodeURIComponent(token)}`);
    return true;
  }

  boardSummary(invitation: BoardInvitationLookupResponse): string {
    const boards = invitation.boards ?? [];
    return boards.length > 0 ? boards.map((board) => board.boardName).join(", ") : invitation.boardName;
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
    this.turnstile.initialize();
  }

}

function errorMessage(body: unknown): string | null {
  if (!body || typeof body !== "object" || !("message" in body)) return null;
  const message = body.message;
  return typeof message === "string" ? message : null;
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


// Typed against the shared DTO (compile-checked drift protection; the schema itself cannot be
// imported at runtime here without dragging drizzle into the browser bundle). Deliberately lenient:
// only the fields this page cannot work without are required, so response-shape skew during a
// rolling deploy degrades the banner instead of throwing a valid invitation away.
function parseBoardInviteSummaryResponse(value: unknown): BoardInvitationLookupResponse {
  const invitation = value as BoardInvitationLookupResponse | null;
  if (!invitation || typeof invitation.id !== "string" || typeof invitation.email !== "string") {
    throw new Error("Invalid board invite response");
  }
  return invitation;
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

function validationError(message: string | null) {
  return message ? { kind: "validation", message } : undefined;
}

function touchedFormError(formTree: () => { touched(): boolean; errorSummary(): readonly { message?: string }[] }): string | null {
  return formTree().touched() ? formTree().errorSummary()[0]?.message ?? null : null;
}
