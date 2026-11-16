import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import type { OnInit } from "@angular/core";
import { disabled, form, FormField, minLength, required, submit, validate } from "@angular/forms/signals";
import type { SignInMethodsResponse } from "@kanera/shared/dto";
import type { SignInProvider } from "@kanera/shared/schema";
import { ApiClient, ApiError } from "../../../core/api/api.client";
import { PublicAuthClient } from "../../../core/auth/public-auth.client";
import { loadSignInProviders, PROVIDER_ICONS, PROVIDER_NAMES } from "../../auth/provider-sign-in.component";
import { DocsLinkComponent } from "../../../shared/docs-link.component";
import { mfaQrDataUrl } from "../../../shared/mfa-qr";
import { ToastService } from "../../../shared/toast.service";

@Component({
  selector: "k-account-settings-account-security",
  standalone: true,
  imports: [DocsLinkComponent, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./account-security.page.html",
})
export class AccountSettingsAccountSecurityPage implements OnInit {
  private readonly api = inject(ApiClient);
  private readonly toasts = inject(ToastService);
  private readonly publicAuth = inject(PublicAuthClient);
  // Accounts created through Google / Microsoft / GitHub may have no password. Password-gated
  // actions then confirm the owner with a code emailed to the account instead.
  protected readonly hasPassword = signal(true);
  protected readonly stepUpCode = signal("");
  protected readonly stepUpSent = signal(false);
  protected readonly stepUpBusy = signal(false);
  protected readonly availableProviders = signal<SignInProvider[]>([]);
  protected readonly identities = signal<SignInMethodsResponse["identities"]>([]);
  protected readonly providerBusy = signal<SignInProvider | null>(null);
  protected readonly providerError = signal<string | null>(null);
  protected readonly providerRows = computed(() => this.availableProviders().map((provider) => ({
    provider,
    name: PROVIDER_NAMES[provider],
    icon: PROVIDER_ICONS[provider],
    identity: this.identities().find((identity) => identity.provider === provider) ?? null,
  })));
  protected readonly mfaEnabled = signal(false);
  protected readonly mfaPassword = signal("");
  protected readonly mfaCode = signal("");
  protected readonly mfaSecret = signal("");
  protected readonly mfaQrUrl = signal("");
  protected readonly mfaRecoveryCodes = signal<string[]>([]);
  protected readonly mfaBusy = signal(false);
  protected readonly mfaError = signal<string | null>(null);
  protected readonly passwordModel = signal({
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
  });
  protected readonly passwordForm = form(this.passwordModel, (password) => {
    validate(password.currentPassword, ({ value }) => (this.hasPassword() && !value()
      ? { kind: "required", message: $localize`Current password is required.` }
      : undefined));
    required(password.newPassword, { message: $localize`New password is required.` });
    minLength(password.newPassword, 8, { message: $localize`New password must be at least 8 characters.` });
    required(password.confirmPassword, { message: $localize`Confirm new password is required.` });
    minLength(password.confirmPassword, 8, { message: $localize`Confirm new password must be at least 8 characters.` });
    validate(password.confirmPassword, (context) => {
      const confirmation = context.value();
      const nextPassword = context.valueOf(password.newPassword);
      if (!confirmation || !nextPassword || confirmation === nextPassword) return undefined;
      return { kind: "passwordMismatch", message: $localize`New password and confirmation do not match.` };
    });

    // Submitting propagates from the root to each field. Expressing the lock as form logic keeps
    // native disabled state synchronized through FormField without a parallel saving signal.
    disabled(password.currentPassword, { when: ({ state }) => state.submitting() });
    disabled(password.newPassword, { when: ({ state }) => state.submitting() });
    disabled(password.confirmPassword, { when: ({ state }) => state.submitting() });
  });
  protected readonly showCurrentPassword = signal(false);
  protected readonly showNewPassword = signal(false);
  protected readonly showConfirmPassword = signal(false);
  protected readonly showPasswordLabel = $localize`:Button — reveal the typed password:Show password`;
  protected readonly hidePasswordLabel = $localize`:Button — mask the typed password:Hide password`;

  async ngOnInit() {
    const [status, methods, providers] = await Promise.all([
      this.api.get<{ enabled: boolean }>("/auth/mfa"),
      this.api.get<SignInMethodsResponse>("/auth/me/sign-in-methods"),
      loadSignInProviders(this.publicAuth),
    ]);
    this.mfaEnabled.set(status.enabled);
    this.hasPassword.set(methods.hasPassword);
    this.identities.set(methods.identities);
    this.availableProviders.set(providers);
  }

  /** The proof a password-gated action sends: the password, or the emailed code when there is none. */
  private stepUpProof(): { currentPassword: string } | { emailCode: string } {
    return this.hasPassword() ? { currentPassword: this.mfaPassword() } : { emailCode: this.stepUpCode().trim() };
  }

  private hasStepUpProof(): boolean {
    return this.hasPassword() ? !!this.mfaPassword() : /^\d{6}$/.test(this.stepUpCode().trim());
  }

  private stepUpMissingMessage(): string {
    return this.hasPassword()
      ? $localize`Enter your current password.`
      : $localize`Enter the six-digit code we emailed you.`;
  }

  protected async sendStepUpCode() {
    this.stepUpBusy.set(true);
    try {
      await this.api.post("/auth/me/step-up-code", {});
      this.stepUpSent.set(true);
      this.toasts.success($localize`We emailed you a code.`, "mail-check");
    } catch (err) {
      this.mfaError.set(extractErrorMessage(err));
    } finally {
      this.stepUpBusy.set(false);
    }
  }

  protected async connectProvider(provider: SignInProvider) {
    this.providerBusy.set(provider);
    this.providerError.set(null);
    try {
      const { authorizeUrl } = await this.api.post<{ authorizeUrl: string }>(`/auth/me/identities/${provider}/begin`, { returnUrl: "/settings/account-security" });
      window.location.assign(authorizeUrl);
    } catch {
      this.providerBusy.set(null);
      this.providerError.set($localize`Couldn't reach ${PROVIDER_NAMES[provider]}:provider:. Try again.`);
    }
  }

  protected async disconnectProvider(provider: SignInProvider) {
    this.providerBusy.set(provider);
    this.providerError.set(null);
    try {
      await this.api.delete(`/auth/me/identities/${provider}`);
      this.identities.update((identities) => identities.filter((identity) => identity.provider !== provider));
      this.toasts.success($localize`${PROVIDER_NAMES[provider]}:provider: disconnected.`, "plug-connected-x");
    } catch (err) {
      const code = err instanceof ApiError ? (err.body as { code?: unknown } | null)?.code : null;
      this.providerError.set(code === "LAST_SIGN_IN_METHOD"
        ? $localize`Set a password or connect another sign-in method before removing this one.`
        : $localize`Couldn't disconnect ${PROVIDER_NAMES[provider]}:provider:. Try again.`);
    } finally {
      this.providerBusy.set(null);
    }
  }

  protected async startMfa() {
    if (!this.hasStepUpProof()) {
      this.mfaError.set(this.hasPassword() ? $localize`Enter your current password to set up an authenticator.` : this.stepUpMissingMessage());
      return;
    }
    await this.runMfa(async () => {
      const setup = await this.api.post<{ secret: string; otpauthUri: string }>("/auth/mfa/enroll", this.stepUpProof());
      this.mfaSecret.set(setup.secret);
      this.mfaQrUrl.set(mfaQrDataUrl(setup.otpauthUri));
    });
  }

  protected async confirmMfa() {
    if (!/^\d{6}$/.test(this.mfaCode().trim())) { this.mfaError.set($localize`Enter the six-digit code from your authenticator app.`); return; }
    await this.runMfa(async () => {
      const result = await this.api.post<{ recoveryCodes: string[] }>("/auth/mfa/enroll/confirm", { code: this.mfaCode() });
      this.mfaEnabled.set(true); this.mfaRecoveryCodes.set(result.recoveryCodes); this.mfaSecret.set(""); this.mfaQrUrl.set(""); this.mfaCode.set("");
    });
  }

  protected async regenerateMfaCodes() {
    if (!this.hasStepUpProof()) { this.mfaError.set(this.stepUpMissingMessage()); return; }
    if (!this.mfaCode().trim()) { this.mfaError.set($localize`Enter an authenticator or recovery code.`); return; }
    await this.runMfa(async () => { const result = await this.api.post<{ recoveryCodes: string[] }>("/auth/mfa/recovery-codes", { ...this.stepUpProof(), code: this.mfaCode() }); this.mfaRecoveryCodes.set(result.recoveryCodes); });
  }

  protected async disableMfa() {
    if (!this.hasStepUpProof()) { this.mfaError.set(this.stepUpMissingMessage()); return; }
    if (!this.mfaCode().trim()) { this.mfaError.set($localize`Enter an authenticator or recovery code.`); return; }
    await this.runMfa(async () => { await this.api.delete("/auth/mfa", { ...this.stepUpProof(), code: this.mfaCode() }); this.mfaEnabled.set(false); this.mfaRecoveryCodes.set([]); this.mfaCode.set(""); });
  }

  private async runMfa(action: () => Promise<void>) {
    this.mfaBusy.set(true); this.mfaError.set(null);
    try { await action(); } catch (err) { this.mfaError.set(extractErrorMessage(err)); } finally { this.mfaBusy.set(false); }
  }

  protected changePassword(event: Event) {
    event.preventDefault();
    return submit(this.passwordForm, async (passwordForm) => {
      const password = this.passwordModel();
      try {
        const settingFirstPassword = !this.hasPassword();
        await this.api.post("/auth/change-password", {
          ...(settingFirstPassword ? { emailCode: this.stepUpCode().trim() } : { currentPassword: password.currentPassword }),
          newPassword: password.newPassword,
        });
        passwordForm().reset({ currentPassword: "", newPassword: "", confirmPassword: "" });
        if (settingFirstPassword) {
          this.hasPassword.set(true);
          this.stepUpCode.set("");
          this.stepUpSent.set(false);
          this.toasts.success($localize`Password set. You'll be signed out on the next refresh.`, "lock-check");
        } else {
          this.toasts.success($localize`Password changed. You'll be signed out on the next refresh.`, "lock-check");
        }
        return undefined;
      } catch (error) {
        return {
          kind: "server",
          message: passwordErrorMessage(error),
          fieldTree: error instanceof ApiError && error.status === 401
            ? passwordForm.currentPassword
            : passwordForm,
        };
      }
    });
  }

}

function extractErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const message = (err.body as { message?: unknown } | null)?.message;
    if (message === "invalid verification code") return $localize`That verification code is incorrect. Try again.`;
    if (message === "invalid password") return $localize`Your current password is incorrect.`;
    if (message === "validation failed") return $localize`Check the highlighted details and try again.`;
    if (typeof message === "string" && message.trim()) return message;
    return $localize`Unable to update two-factor authentication. Try again.`;
  }
  if (err instanceof Error) return err.message;
  return $localize`Something went wrong.`;
}

function passwordErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) return $localize`Your current password is incorrect.`;
  if (error instanceof ApiError) {
    const message = (error.body as { message?: unknown } | null)?.message;
    if (typeof message === "string" && message.trim()) return message;
    return $localize`Unable to change your password. Try again.`;
  }
  if (error instanceof Error) return error.message;
  return $localize`Unable to change your password. Try again.`;
}
