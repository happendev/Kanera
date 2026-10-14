import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { UpdatesService } from "../core/updates/updates.service";
import { ToastComponent } from "./toast.component";

@Component({
  selector: "k-update-prompt",
  standalone: true,
  imports: [ToastComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <k-toast [show]="updates.updateAvailable()" icon="refresh" message="Update available" i18n-message="Toast when a new app version is ready">
      <button type="button" class="sm" (click)="updates.applyUpdate()" i18n="Button: reload the page to apply the app update">Refresh</button>
    </k-toast>
  `,
})
export class UpdatePromptComponent {
  readonly updates = inject(UpdatesService);
}
