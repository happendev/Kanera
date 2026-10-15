import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import type { OnInit } from "@angular/core";
import { disabled, form, FormField, minLength, required, submit, validate } from "@angular/forms/signals";
import { ApiClient, ApiError } from "../../../core/api/api.client";
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
    required(password.currentPassword, { message: $localize`Current password is required.` });
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
    const status = await this.api.get<{ enabled: boolean }>("/auth/mfa");
    this.mfaEnabled.set(status.enabled);
  }

  protected async startMfa() {
    if (!this.mfaPassword()) { this.mfaError.set($localize`Enter your current password to set up an authenticator.`); return; }
    await this.runMfa(async () => {
      const setup = await this.api.post<{ secret: string; otpauthUri: string }>("/auth/mfa/enroll", { currentPassword: this.mfaPassword() });
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
    if (!this.mfaPassword()) { this.mfaError.set($localize`Enter your current password.`); return; }
    if (!this.mfaCode().trim()) { this.mfaError.set($localize`Enter an authenticator or recovery code.`); return; }
    await this.runMfa(async () => { const result = await this.api.post<{ recoveryCodes: string[] }>("/auth/mfa/recovery-codes", { currentPassword: this.mfaPassword(), code: this.mfaCode() }); this.mfaRecoveryCodes.set(result.recoveryCodes); });
  }

  protected async disableMfa() {
    if (!this.mfaPassword()) { this.mfaError.set($localize`Enter your current password.`); return; }
    if (!this.mfaCode().trim()) { this.mfaError.set($localize`Enter an authenticator or recovery code.`); return; }
    await this.runMfa(async () => { await this.api.delete("/auth/mfa", { currentPassword: this.mfaPassword(), code: this.mfaCode() }); this.mfaEnabled.set(false); this.mfaRecoveryCodes.set([]); this.mfaCode.set(""); });
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
        await this.api.post("/auth/change-password", {
          currentPassword: password.currentPassword,
          newPassword: password.newPassword,
        });
        passwordForm().reset({ currentPassword: "", newPassword: "", confirmPassword: "" });
        this.toasts.success($localize`Password changed. You'll be signed out on the next refresh.`, "lock-check");
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
