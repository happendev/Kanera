import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from "@angular/core";
import { disabled, form, FormField, submit, validate } from "@angular/forms/signals";
import { Router, RouterLink } from "@angular/router";
import { PublicAuthClient } from "../../core/auth/public-auth.client";
import { LogoComponent } from "../../shared/logo.component";

@Component({
  selector: "k-reset-password",
  standalone: true,
  imports: [RouterLink, LogoComponent, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./reset-password.page.html",
  styleUrl: "./login.page.scss",
})
export class ResetPasswordPage {
  private readonly router = inject(Router);
  private readonly publicAuth = inject(PublicAuthClient);
  readonly token = input<string | null>(null);
  readonly resetPasswordModel = signal({ password: "", confirm: "" });
  readonly resetPasswordForm = form(this.resetPasswordModel, (passwordReset) => {
    validate(passwordReset.password, ({ value }) => validationError(validatePassword(value())));
    validate(passwordReset.confirm, (context) => {
      const message = validatePassword(context.value(), "Confirm password")
        ?? (context.value() === context.valueOf(passwordReset.password) ? null : "Passwords do not match.");
      return validationError(message);
    });
    disabled(passwordReset.password, { when: ({ state }) => state.submitting() });
    disabled(passwordReset.confirm, { when: ({ state }) => state.submitting() });
  });
  readonly password = this.resetPasswordForm.password().value;
  readonly confirm = this.resetPasswordForm.confirm().value;
  readonly error = computed(() => touchedFormError(this.resetPasswordForm));
  readonly success = signal(false);
  readonly busy = computed(() => this.resetPasswordForm().submitting());
  readonly showPassword = signal(false);
  readonly showConfirm = signal(false);

  submit(e: Event) {
    e.preventDefault();
    this.success.set(false);
    return submit(this.resetPasswordForm, async () => {
      const token = this.token();
      if (!token) return { kind: "token", message: "Reset link is missing a token." };
      try {
        const res = await this.publicAuth.post("/auth/reset-password", { token, password: this.password() });
        if (!res.ok) return { kind: "server", message: "Reset link is invalid or expired." };
        this.success.set(true);
        setTimeout(() => void this.router.navigateByUrl("/login"), 1200);
        return undefined;
      } catch {
        return { kind: "server", message: "We could not reset your password. Check your connection and try again." };
      }
    });
  }
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
