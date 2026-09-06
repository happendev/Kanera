import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { ToastService } from "./toast.service";
import { ToastComponent } from "./toast.component";

@Component({
  // Renders the ToastService queue. Mounted once in the root component so toasts survive route
  // changes and menu teardown.
  selector: "k-toast-stack",
  standalone: true,
  imports: [ToastComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (toast of toasts.rendered(); track toast.id) {
      <k-toast [show]="!toast.leaving" [icon]="toast.icon" [variant]="toast.variant" [message]="toast.message">
        @if (toast.action; as action) {
          <button type="button" class="action" (click)="action.run()">{{ action.label }}</button>
        }
        <button type="button" class="close" aria-label="Dismiss notification" (click)="toasts.dismiss(toast.id)">
          <i class="ti ti-x" aria-hidden="true"></i>
        </button>
      </k-toast>
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
export class ToastStackComponent {
  readonly toasts = inject(ToastService);
}
