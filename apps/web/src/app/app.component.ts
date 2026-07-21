import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { RouterOutlet } from "@angular/router";
import { AuthSyncService } from "./core/auth/auth-sync.service";
import { CookieConsentComponent } from "./core/consent/cookie-consent.component";
import { ThemeService } from "./core/theme/theme.service";

@Component({
  selector: "k-root",
  standalone: true,
  imports: [RouterOutlet, CookieConsentComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<router-outlet /><k-cookie-consent />`,
})
export class AppComponent {
  private readonly authSync = inject(AuthSyncService);
  private readonly theme = inject(ThemeService);
}
