import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { UpdatesService } from "../core/updates/updates.service";
import { StatusToastComponent } from "./status-toast.component";

@Component({
  selector: "k-update-prompt",
  standalone: true,
  imports: [StatusToastComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <k-status-toast [show]="updates.updateAvailable()" icon="refresh" message="Update available">
      <button type="button" class="sm" (click)="updates.applyUpdate()">Refresh</button>
    </k-status-toast>
  `,
})
export class UpdatePromptComponent {
  readonly updates = inject(UpdatesService);
}
