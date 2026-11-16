import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from "@angular/core";
import type { OnInit } from "@angular/core";
import { Router, RouterLink } from "@angular/router";
import type { ProviderSignInError } from "@kanera/shared/dto";
import type { SignInProvider } from "@kanera/shared/schema";
import { AuthService } from "../../core/auth/auth.service";
import { PublicAuthClient } from "../../core/auth/public-auth.client";
import { isMfaEnrollmentRequired, MFA_ENROLLMENT_HANDOFF_KEY, MFA_VERIFY_HANDOFF_KEY, parseAuthResponse } from "../../core/auth/auth-response";
import { LogoComponent } from "../../shared/logo.component";
import { LocaleSwitcherComponent } from "./locale-switcher.component";

// Matches the email signup form: a new organisation takes this default name, renamed later.
const DEFAULT_ORG_NAME = $localize`:Default name for a new organisation:Private`;

type Step =
  | { kind: "working" }
  | { kind: "error"; message: string }
  | { kind: "code"; email: string }
  | { kind: "signup"; email: string; joiningOrganisation: string | null };

type CompleteResponse = {
  status?: string;
  challengeToken?: string;
  email?: string;
  displayName?: string | null;
  joiningOrganisation?: string | null;
  provider?: SignInProvider;
  returnUrl?: string | null;
};

function providerErrorMessage(error: string | null | undefined): string {
  switch (error as ProviderSignInError | null | undefined) {
    case "cancelled": return $localize`Sign-in was cancelled.`;
    case "email_missing": return $localize`That account didn't share an email address with Kanera. Make one visible on the account, or sign in with your email.`;
    case "account_unavailable": return $localize`This Kanera account isn't available. Contact support if you think this is a mistake.`;
    case "signups_closed": return $localize`No Kanera account uses that email, and new sign-ups are closed. Ask for an invitation.`;
    case "invalid_invite": return $localize`This invitation is invalid or has expired.`;
    case "board_invite_email_mismatch": return $localize`This invitation was sent to a different email address. Continue with the account that uses the invited address.`;
    case "identity_in_use": return $localize`That account is already connected to a different Kanera account.`;
    case "provider_already_linked": return $localize`Your Kanera account is already connected to a different account with this provider. Disconnect it first in Account security.`;
    case "expired": return $localize`This sign-in has expired. Start again.`;
    default: return $localize`We couldn't sign you in. Try again.`;
  }
}

function safeReturnUrl(value: string | null | undefined): string | null {
  return value?.startsWith("/") && !value.startsWith("//") ? value : null;
}

/**
 * Where the browser lands after Google / Microsoft / GitHub. The API has already resolved who is
 * signing in; this page redeems the one-time handoff and finishes whatever is left (an emailed code
 * for an address the provider did not verify, or the name for a brand-new account).
 */
@Component({
  selector: "k-provider-callback",
  standalone: true,
  imports: [LogoComponent, LocaleSwitcherComponent, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: "./login.page.scss",
  template: `
    <div class="auth-root">
      <div class="auth-card">
        <div class="auth-header">
          <k-logo [height]="34" />
          @switch (step().kind) {
            @case ("working") { <p i18n>Signing you in…</p> }
            @case ("code") { <p i18n>Confirm your email address</p> }
            @case ("signup") { <p i18n>Create your Kanera account</p> }
            @case ("error") { <p i18n>Sign-in didn't finish</p> }
          }
        </div>

        @switch (step().kind) {
          @case ("working") {
            <p class="callback-status"><i aria-hidden="true" class="ti ti-loader-2 kanera-spin"></i></p>
          }
          @case ("code") {
            <form (submit)="submitCode($event)">
              <p i18n>We sent a six-digit code to <strong>{{ stepEmail() // i18n(ph="email") }}</strong>. Enter it to continue.</p>
              <div class="field">
                <label for="provider-code"><i aria-hidden="true" class="ti ti-mail-check"></i> <ng-container i18n="Field label">Verification code</ng-container></label>
                <input id="provider-code" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" [value]="code()" (input)="code.set($any($event.target).value)" autofocus />
              </div>
              @if (formError()) { <div class="error-banner"><i aria-hidden="true" class="ti ti-alert-circle"></i> {{ formError() }}</div> }
              <button type="submit" class="submit-btn" [disabled]="busy()">
                @if (busy()) { <i aria-hidden="true" class="ti ti-loader-2 kanera-spin"></i> }
                <ng-container i18n="Button">Continue</ng-container>
              </button>
            </form>
          }
          @case ("signup") {
            <form (submit)="submitSignup($event)">
              @if (joiningOrganisation(); as org) {
                <p i18n>You're joining <strong>{{ org // i18n(ph="organisation") }}</strong> as {{ stepEmail() // i18n(ph="email") }}.</p>
              } @else {
                <p i18n>No Kanera account uses {{ stepEmail() // i18n(ph="email") }} yet. Add your name to create one.</p>
              }
              <div class="field">
                <label for="provider-name"><i aria-hidden="true" class="ti ti-user"></i> <ng-container i18n="Field label">Your name</ng-container></label>
                <input id="provider-name" autocomplete="name" [value]="displayName()" (input)="displayName.set($any($event.target).value)" autofocus />
              </div>
              @if (formError()) { <div class="error-banner"><i aria-hidden="true" class="ti ti-alert-circle"></i> {{ formError() }}</div> }
              <p class="legal-consent" i18n>
        By continuing, you agree to the
        <a href="https://www.kanera.app/terms" target="_blank" rel="noopener">Terms of Service</a>
        and acknowledge the
        <a href="https://www.kanera.app/privacy" target="_blank" rel="noopener">Privacy Policy</a>.
      </p>
              <button type="submit" class="submit-btn" [disabled]="busy()">
                @if (busy()) { <i aria-hidden="true" class="ti ti-loader-2 kanera-spin"></i> }
                <ng-container i18n="Button">Create account</ng-container>
              </button>
            </form>
          }
          @case ("error") {
            <div class="error-banner"><i aria-hidden="true" class="ti ti-alert-circle"></i> {{ errorMessage() }}</div>
            <a class="submit-btn callback-back" [routerLink]="backLink()">
              @if (intent() === "link") { <ng-container i18n="Link back to account security settings">Back to account security</ng-container> } @else { <ng-container i18n="Link back to the sign-in page">Back to sign in</ng-container> }
            </a>
          }
        }
      </div>
      <k-locale-switcher />
    </div>
  `,
  styles: [`
    .callback-status { display: flex; justify-content: center; font-size: 22px; color: var(--text-muted); }
    .callback-back { display: flex; align-items: center; justify-content: center; margin-top: 16px; text-decoration: none; }
    .legal-consent { margin: 4px 0 14px; font-size: var(--text-sm); color: var(--text-muted); }
  `],
})
export class ProviderCallbackPage implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly publicAuth = inject(PublicAuthClient);
  private readonly router = inject(Router);

  /** One-time handoff code from the API callback. */
  readonly h = input<string>();
  readonly error = input<string>();
  readonly intent = input<string>();

  protected readonly step = signal<Step>({ kind: "working" });
  protected readonly code = signal("");
  protected readonly displayName = signal("");
  protected readonly busy = signal(false);
  protected readonly formError = signal<string | null>(null);
  protected readonly stepEmail = computed(() => {
    const step = this.step();
    return step.kind === "code" || step.kind === "signup" ? step.email : "";
  });
  protected readonly joiningOrganisation = computed(() => {
    const step = this.step();
    return step.kind === "signup" ? step.joiningOrganisation : null;
  });
  protected readonly errorMessage = computed(() => {
    const step = this.step();
    return step.kind === "error" ? step.message : "";
  });
  protected readonly backLink = computed(() => (this.intent() === "link" ? "/settings/account-security" : "/login"));

  async ngOnInit() {
    const handoff = this.h();
    if (!handoff) {
      this.step.set({ kind: "error", message: providerErrorMessage(this.error()) });
      return;
    }
    await this.complete({});
  }

  protected async submitCode(event: Event) {
    event.preventDefault();
    const code = this.code().trim();
    if (!/^\d{6}$/.test(code)) { this.formError.set($localize`Enter the six-digit code from the email.`); return; }
    await this.complete({ code });
  }

  protected async submitSignup(event: Event) {
    event.preventDefault();
    const displayName = this.displayName().trim();
    if (!displayName) { this.formError.set($localize`Name is required.`); return; }
    await this.complete({ signup: { displayName, orgName: DEFAULT_ORG_NAME } });
  }

  private async complete(extra: { code?: string; signup?: { displayName: string; orgName: string } }) {
    this.busy.set(true);
    this.formError.set(null);
    try {
      const res = await this.publicAuth.post("/auth/providers/complete", { handoff: this.h(), ...extra });
      const body = await res.json().catch(() => null) as (CompleteResponse & { code?: string; message?: string; details?: { reason?: string } }) | null;
      if (!res.ok) {
        this.handleFailure(res.status, body, !!extra.code);
        return;
      }
      await this.handleResponse(body ?? {});
    } catch {
      this.formError.set($localize`Unable to reach the server. Check your connection and try again.`);
      if (this.step().kind === "working") this.step.set({ kind: "error", message: $localize`Unable to reach the server. Check your connection and try again.` });
    } finally {
      this.busy.set(false);
    }
  }

  private handleFailure(status: number, body: { code?: string; message?: string; details?: { reason?: string } } | null, wasCode: boolean) {
    // A wrong emailed code keeps the code step open so the person can retry.
    if (wasCode && status === 400) {
      this.formError.set($localize`Invalid or expired verification code`);
      return;
    }
    if (body?.code === "SEAT_LIMIT_REACHED") {
      this.step.set({ kind: "error", message: $localize`This organisation has no available seats. Ask an admin to purchase more seats before you can accept this invitation.` });
      return;
    }
    if (body?.code === "PROVIDER_SIGN_IN_EXPIRED") {
      this.step.set({ kind: "error", message: providerErrorMessage("expired") });
      return;
    }
    if (body?.code === "PROVIDER_SIGN_IN_FAILED") {
      this.step.set({ kind: "error", message: providerErrorMessage(body.details?.reason) });
      return;
    }
    this.step.set({ kind: "error", message: body?.message?.trim() || providerErrorMessage(null) });
  }

  private async handleResponse(body: CompleteResponse) {
    const returnUrl = safeReturnUrl(body.returnUrl);
    switch (body.status) {
      case "email_code_required":
        this.code.set("");
        this.step.set({ kind: "code", email: body.email ?? "" });
        return;
      case "signup_details_required":
        this.displayName.set(body.displayName ?? "");
        this.step.set({ kind: "signup", email: body.email ?? "", joiningOrganisation: body.joiningOrganisation ?? null });
        return;
      case "linked":
        await this.router.navigateByUrl(returnUrl ?? "/settings/account-security");
        return;
      case "mfa_required": {
        // The account has its own two-factor authentication; the login page asks for the code.
        const login = returnUrl ? `/login?returnUrl=${encodeURIComponent(returnUrl)}` : "/login";
        await this.router.navigateByUrl(login, { state: { [MFA_VERIFY_HANDOFF_KEY]: body.challengeToken } });
        return;
      }
    }
    if (isMfaEnrollmentRequired(body)) {
      await this.router.navigateByUrl("/login", { state: { [MFA_ENROLLMENT_HANDOFF_KEY]: body.challengeToken } });
      return;
    }
    const session = parseAuthResponse(body);
    this.auth.setSession(session.accessToken, session.user);
    await this.router.navigateByUrl(session.user.boardInviteRedirect ?? returnUrl ?? "/");
  }
}
