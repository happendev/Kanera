import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { ActionToastService } from "./action-toast.service";
import { StatusToastComponent } from "./status-toast.component";

@Component({
  selector: "k-action-toasts",
  standalone: true,
  imports: [StatusToastComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (toast of toasts.messages(); track toast.id) {
      <k-status-toast [show]="true" [icon]="toast.icon" [success]="true" [message]="toast.message">
        <button type="button" aria-label="Dismiss notification" (click)="toasts.dismiss(toast.id)">
          <i class="ti ti-x" aria-hidden="true"></i>
        </button>
      </k-status-toast>
    }
  `,
  styles: `
    button { display: flex; padding: 4px; border: 0; border-radius: var(--radius-sm);
      background: transparent; color: var(--text-muted); cursor: pointer; }
    button:hover { color: var(--text); background: var(--surface-hover); }
  `,
})
export class ActionToastsComponent {
  readonly toasts = inject(ActionToastService);
}
