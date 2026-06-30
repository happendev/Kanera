import { ChangeDetectionStrategy, Component, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import { environment } from "../../../environments/environment";
import { LogoComponent } from "../../shared/logo.component";

@Component({
  selector: "k-forgot-password",
  standalone: true,
  imports: [RouterLink, LogoComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./forgot-password.page.html",
  styleUrl: "./login.page.scss",
})
export class ForgotPasswordPage {
  readonly email = signal("");
  readonly sent = signal(false);
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);

  async submit(e: Event) {
    e.preventDefault();
    const email = this.email().trim();

    this.error.set(null);
    this.sent.set(false);
    this.error.set(validateEmail(email));
    if (this.error()) return;

    this.busy.set(true);
    try {
      const res = await fetch(`${environment.apiUrl}/auth/forgot-password`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        this.error.set("We could not create a reset link. Check the email and try again.");
        return;
      }
      this.sent.set(true);
    } catch {
      this.error.set("We could not create a reset link. Check your connection and try again.");
    } finally {
      this.busy.set(false);
    }
  }
}

function validateEmail(email: string): string | null {
  if (!email) return "Email is required.";
  if (email.length > 254) return "Email must be 254 characters or fewer.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Enter a valid email address.";
  return null;
}
