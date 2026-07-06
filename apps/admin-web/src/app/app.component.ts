import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { RouterOutlet } from "@angular/router";
import { ToastsComponent } from "./shared/toast.component";
import { ToastService } from "./shared/toast.service";
import { AdminAuthSyncService } from "./core/auth/admin-auth-sync.service";
import { UpdatePromptComponent } from "./shared/update-prompt.component";

@Component({
  selector: "a-root",
  standalone: true,
  imports: [RouterOutlet, ToastsComponent, UpdatePromptComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Toasts live at the root so they render over every route, including the (shell-less) login page.
  template: `<router-outlet /><a-update-prompt /><a-toasts />`,
})
export class AppComponent {
  private readonly authSync = inject(AdminAuthSyncService);
  // Eagerly construct the toast service at the root so its stack is shared app-wide.
  protected readonly toasts = inject(ToastService);
}
