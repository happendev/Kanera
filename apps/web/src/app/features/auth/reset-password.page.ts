import { ChangeDetectionStrategy, Component, inject, input, signal } from "@angular/core";
import { Router, RouterLink } from "@angular/router";
import { environment } from "../../../environments/environment";
import { LogoComponent } from "../../shared/logo.component";

@Component({
  selector: "k-reset-password",
  standalone: true,
  imports: [RouterLink, LogoComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./reset-password.page.html",
  styleUrl: "./login.page.scss",
})
export class ResetPasswordPage {
  private readonly router = inject(Router);
  readonly token = input<string | null>(null);
  readonly password = signal("");
  readonly confirm = signal("");
  readonly error = signal<string | null>(null);
  readonly success = signal(false);
  readonly busy = signal(false);
  readonly showPassword = signal(false);
  readonly showConfirm = signal(false);

  async submit(e: Event) {
    e.preventDefault();
    this.error.set(null);
    this.success.set(false);
    const token = this.token();
    if (!token) {
      this.error.set("Reset link is missing a token.");
      return;
    }
    const passwordError = validatePassword(this.password()) ?? validatePassword(this.confirm(), "Confirm password");
    if (passwordError) {
      this.error.set(passwordError);
      return;
    }
    if (this.password() !== this.confirm()) {
      this.error.set("Passwords do not match.");
      return;
    }
    this.busy.set(true);
    try {
      const res = await fetch(`${environment.apiUrl}/auth/reset-password`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password: this.password() }),
      });
      if (!res.ok) {
        this.error.set("Reset link is invalid or expired.");
        return;
      }
      this.success.set(true);
      setTimeout(() => void this.router.navigateByUrl("/login"), 1200);
    } catch {
      this.error.set("We could not reset your password. Check your connection and try again.");
    } finally {
      this.busy.set(false);
    }
  }
}

function validatePassword(password: string, label = "Password"): string | null {
  if (!password) return `${label} is required.`;
  if (password.length < 8) return `${label} must be at least 8 characters.`;
  if (password.length > 200) return `${label} must be 200 characters or fewer.`;
  return null;
}
