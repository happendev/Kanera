import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { Router } from "@angular/router";
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
        <label>
          <span class="muted">Password</span>
          <input class="input" type="password" autocomplete="current-password" [value]="password()" (input)="password.set($any($event.target).value)" />
        </label>

        @if (error()) {
          <p class="badge badge-danger">{{ error() }}</p>
        }

        <button class="btn btn-primary" type="submit" [disabled]="loading()">
          {{ loading() ? "Signing in…" : "Sign in" }}
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

  async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.loading()) return;
    this.error.set(null);
    this.loading.set(true);
    try {
      await this.auth.login(this.email().trim(), this.password());
      await this.router.navigate(["/"]);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : "Login failed");
    } finally {
      this.loading.set(false);
    }
  }
}
