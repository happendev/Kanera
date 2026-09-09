import { ToastService } from "./shared/toast.service";
import { ToastStackComponent } from "./shared/toast-stack.component";
import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { RouterOutlet } from "@angular/router";
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
  private readonly theme = inject(ThemeService);
}
