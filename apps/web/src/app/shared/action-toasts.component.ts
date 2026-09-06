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
      <k-status-toast [show]="true" [icon]="toast.icon" [success]="toast.success" [message]="toast.message">
        @if (toast.action; as action) {
          <button type="button" class="action" (click)="action.run()">{{ action.label }}</button>
        }
        <button type="button" class="close" aria-label="Dismiss notification" (click)="toasts.dismiss(toast.id)">
          <i class="ti ti-x" aria-hidden="true"></i>
        </button>
      </k-status-toast>
    }
  `,
  styles: `
    button { display: flex; align-items: center; height: auto; padding: 4px; border: 0; border-radius: var(--radius-sm);
      background: transparent; color: var(--text-muted); cursor: pointer; flex-shrink: 0; }
    button:hover { color: var(--text); background: var(--surface-hover); }
    /* The undo affordance reads as the toast's primary action: bold, accent-coloured, comfortably tappable. */
    .action { padding: 4px 8px; margin-left: 4px; font-size: 13px; font-weight: 600; color: var(--accent); }
    .action:hover { color: var(--accent); background: var(--surface-hover); }
  `,
})
export class ActionToastsComponent {
  readonly toasts = inject(ActionToastService);
}
