import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { Router } from "@angular/router";
import { renderSVG } from "uqr";
import { AdminAuthService } from "../../core/auth/admin-auth.service";

@Component({
  selector: "a-login-page",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="login-wrap">
      <form class="card login-card" (submit)="submit($event)">
        <div class="brand">
          <i class="ti ti-shield-lock"></i>
          <div>
            <h1>Kanera Admin</h1>
            <p class="muted">Platform operations console</p>
          </div>
        </div>

        <label>
          <span class="muted">Email</span>
          <input class="input" type="email" autocomplete="username" [value]="email()" (input)="email.set($any($event.target).value)" />
        </label>
        @if (step() !== 'password') {
          @if (step() === 'enroll') {
            <p class="muted">Scan this code with your authenticator app, then enter the six-digit code.</p>
            @if (qrUrl()) { <img class="qr" [src]="qrUrl()" alt="Authenticator setup QR code" /> }
            <code>{{ secret() }}</code>
          } @else {
            <p class="muted">Enter the code from your authenticator app or a recovery code.</p>
          }
          <label><span class="muted">Verification code</span><input class="input" autocomplete="one-time-code" inputmode="numeric" [value]="code()" (input)="code.set($any($event.target).value)" /></label>
        }
        @if (recoveryCodes().length) {
          <p>Save these recovery codes now. Each can be used once.</p>
          <code class="codes">{{ recoveryCodes().join('\n') }}</code>
        }
        <label>
          <span class="muted">Password</span>
          <input class="input" type="password" autocomplete="current-password" [value]="password()" (input)="password.set($any($event.target).value)" />
        </label>

        @if (error()) {
          <p class="badge badge-danger">{{ error() }}</p>
        }

        <button class="btn btn-primary" type="submit" [disabled]="loading()">
          {{ loading() ? "Working…" : (recoveryCodes().length ? "Continue" : step() === 'password' ? "Sign in" : "Verify") }}
        </button>
      </form>
    </div>
  `,
  styles: [
    `
      .login-wrap {
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
      }
      .login-card {
        width: 360px;
        display: flex;
        flex-direction: column;
        gap: 14px;
      }
      .brand {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 4px;
      }
      .brand i {
        font-size: 28px;
        color: var(--accent);
      }
      h1 {
        font-size: 18px;
        margin: 0;
      }
      p {
        margin: 2px 0 0;
        font-size: 13px;
      }
      label {
        display: flex;
        flex-direction: column;
        gap: 5px;
        font-size: 13px;
      }
      .qr { width: 200px; height: 200px; align-self: center; border-radius: 8px; }
      code { overflow-wrap: anywhere; font-size: 12px; }
      .codes { white-space: pre-wrap; padding: 10px; background: var(--surface-subtle); border-radius: 6px; }
    `,
  ],
})
export class LoginPage {
  private readonly auth = inject(AdminAuthService);
  private readonly router = inject(Router);

  readonly email = signal("");
  readonly password = signal("");
  readonly error = signal<string | null>(null);
  readonly loading = signal(false);
  readonly step = signal<"password" | "verify" | "enroll">("password");
  readonly challengeToken = signal("");
  readonly code = signal("");
  readonly secret = signal("");
  readonly qrUrl = signal("");
  readonly recoveryCodes = signal<string[]>([]);

  async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.loading()) return;
    this.error.set(null);
    if (this.recoveryCodes().length === 0 && this.step() === "password" && (!this.email().trim() || !this.password())) {
      this.error.set(!this.email().trim() ? "Enter your email address." : "Enter your password.");
      return;
    }
    if (this.recoveryCodes().length === 0 && this.step() === "enroll" && !/^\d{6}$/.test(this.code().trim())) {
      this.error.set("Enter the six-digit code from your authenticator app.");
      return;
    }
    if (this.recoveryCodes().length === 0 && this.step() === "verify" && !this.code().trim()) {
      this.error.set("Enter your authenticator or recovery code.");
      return;
    }
    this.loading.set(true);
    try {
      if (this.recoveryCodes().length) { await this.auth.acknowledgeMfaRecoveryCodes(this.challengeToken()); await this.router.navigate(["/"]); return; }
      if (this.step() === "password") {
        const result = await this.auth.login(this.email().trim(), this.password());
        this.challengeToken.set(result.challengeToken);
        if (result.status === "mfa_required") this.step.set("verify");
        else {
          this.step.set("enroll");
          const setup = await this.auth.startMfaEnrollment(result.challengeToken);
          this.secret.set(setup.secret);
          this.qrUrl.set(mfaQrDataUrl(setup.otpauthUri));
        }
      } else if (this.step() === "verify") {
        await this.auth.verifyMfa(this.challengeToken(), this.code());
        await this.router.navigate(["/"]);
      } else {
        this.recoveryCodes.set(await this.auth.confirmMfaEnrollment(this.challengeToken(), this.code()));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Login failed";
      this.error.set(message === "validation failed" ? "Check your sign-in details and try again." : message === "invalid verification code" ? "That verification code is incorrect. Try again." : message);
    } finally {
      this.loading.set(false);
    }
  }
}

function mfaQrDataUrl(otpauthUri: string): string {
  const svg = renderSVG(otpauthUri, { border: 4, ecc: "M" });
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
