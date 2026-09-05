import { ActionToastsComponent } from "./shared/action-toasts.component";
import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { RouterOutlet } from "@angular/router";
import { AuthSyncService } from "./core/auth/auth-sync.service";
import { CookieConsentComponent } from "./core/consent/cookie-consent.component";
import { ThemeService } from "./core/theme/theme.service";

@Component({
  selector: "k-root",
  standalone: true,
  imports: [RouterOutlet, CookieConsentComponent, ActionToastsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<router-outlet /><k-cookie-consent /><k-action-toasts />`,
})
export class AppComponent {
  private readonly authSync = inject(AuthSyncService);
  private readonly theme = inject(ThemeService);
}
