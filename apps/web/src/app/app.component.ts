import { ToastService } from "./shared/toast.service";
import { ToastStackComponent } from "./shared/toast-stack.component";
import { ChangeDetectionStrategy, Component, effect, inject } from "@angular/core";
import { RouterOutlet } from "@angular/router";
import { AuthService } from "./core/auth/auth.service";
import { AuthSyncService } from "./core/auth/auth-sync.service";
import { CookieConsentComponent } from "./core/consent/cookie-consent.component";
import { ThemeService } from "./core/theme/theme.service";

@Component({
  selector: "k-root",
  standalone: true,
  imports: [RouterOutlet, CookieConsentComponent, ToastStackComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Keep CDK Overlay out of bootstrap; once loaded, retain the stack across route changes.
  template: `<router-outlet /><k-cookie-consent />
    @defer (when toasts.rendered().length > 0) { <k-toast-stack /> }`,
})
export class AppComponent {
  readonly toasts = inject(ToastService);
  private readonly authSync = inject(AuthSyncService);
  private readonly auth = inject(AuthService);
  private readonly theme = inject(ThemeService);

  // Plain field, not a signal: the effect below writes it, and making it reactive would re-trigger
  // the effect that set it.
  private hadSession = false;

  constructor() {
    // Appearance lives on the account, so the session is what carries it: this covers first load,
    // a refreshed session and an organisation switch alike. The effect re-fires on every unrelated
    // change to the user (unread counts, entitlements), which is why hydrate() is idempotent and
    // writes nothing back — see ThemeService.hydrate().
    effect(() => {
      const user = this.auth.user();
      if (user) {
        this.hadSession = true;
        this.theme.hydrate(user.id, user.theme ?? null, user.accent ?? null);
        return;
      }
      // The session ended — an explicit log out, a cross-tab log out, or a refresh that failed.
      // Driving this off the user signal rather than the log out button catches all three.
      // Guarded on hadSession because this same effect runs with no user during the window before
      // a cold start hydrates, and the cache is exactly what stops a theme flash there.
      if (!this.hadSession) return;
      this.hadSession = false;
      this.theme.reset();
    });
  }
}
