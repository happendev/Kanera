import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { RoleChangePromptService } from "../core/auth/role-change-prompt.service";
import { StatusToastComponent } from "./status-toast.component";

@Component({
  selector: "k-role-change-prompt",
  standalone: true,
  imports: [StatusToastComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <k-status-toast [show]="roleChanges.refreshRequired()" icon="user-shield" message="Permissions changed">
      <button type="button" class="sm" (click)="reload()">Refresh</button>
    </k-status-toast>
  `,
})
export class RoleChangePromptComponent {
  readonly roleChanges = inject(RoleChangePromptService);

  reload(): void {
    document.location.reload();
  }
}
