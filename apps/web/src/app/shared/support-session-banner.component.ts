import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { AuthService } from "../core/auth/auth.service";

// Persistent, unmissable bar shown whenever the browser is running a superadmin support session
// (acting as another org). It is the operator's only always-visible reminder that mutations are
// attributed to a support session, plus the exit control. Renders nothing outside a support session.
@Component({
  selector: "k-support-session-banner",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (auth.supportSession(); as session) {
    <div class="support-banner" role="alert">
      <i aria-hidden="true" class="ti ti-shield-lock"></i>
      <span class="support-banner__text">
        <ng-container i18n="Banner during a staff support session; the placeholder is the customer organisation">Support session — acting as <strong>{{ session.orgName // i18n(ph="organisation") }}</strong>. Changes are attributed to this session.</ng-container>
      </span>
      <button type="button" class="support-banner__end" (click)="end()" [disabled]="ending()">
        @if (ending()) {
          <ng-container i18n="Button while a support session ends">Leaving…</ng-container>
        } @else {
          <ng-container i18n="Button: end the support session">Leave session</ng-container>
        }
      </button>
    </div>
    }
  `,
  styles: [
    `
    .support-banner {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.4rem 0.75rem;
      background: #b45309;
      color: #fff;
      font-size: 0.8125rem;
      font-weight: 500;
    }
    .support-banner i {
      font-size: 1rem;
    }
    .support-banner__text {
      flex: 1;
      min-width: 0;
    }
    .support-banner__end {
      flex: none;
      border: 1px solid rgba(255, 255, 255, 0.6);
      background: transparent;
      color: #fff;
      border-radius: 6px;
      padding: 0.2rem 0.6rem;
      font-size: 0.75rem;
      font-weight: 600;
      cursor: pointer;
    }
    .support-banner__end:hover:not(:disabled) {
      background: rgba(255, 255, 255, 0.15);
    }
    .support-banner__end:disabled {
      opacity: 0.6;
      cursor: default;
    }
    `,
  ],
})
export class SupportSessionBannerComponent {
  readonly auth = inject(AuthService);
  readonly ending = signal(false);

  async end(): Promise<void> {
    if (this.ending()) return;
    this.ending.set(true);
    try {
      await this.auth.exitSupportSession();
      // A hard navigation clears every route-scoped tenant cache. It also runs the auth guard even
      // when the operator leaves from `/`, allowing their refresh cookie to restore their own org.
      window.location.assign("/");
    } finally {
      this.ending.set(false);
    }
  }
}
