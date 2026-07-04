import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { ToastService } from "./toast.service";

@Component({
  selector: "a-toasts",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="toast-wrap">
      @for (t of toasts.toasts(); track t.id) {
        <div class="toast" [class.error]="t.kind === 'error'" (click)="toasts.dismiss(t.id)">
          <i class="ti" [class.ti-check]="t.kind === 'success'" [class.ti-alert-triangle]="t.kind === 'error'"></i>
          <span>{{ t.message }}</span>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .toast-wrap {
        position: fixed;
        bottom: 16px;
        right: 16px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        z-index: 1000;
      }
      .toast {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 14px;
        border-radius: var(--radius);
        border: 1px solid var(--border-strong);
        background: var(--surface);
        color: var(--text);
        font-size: 13px;
        box-shadow: var(--shadow-sm);
        cursor: pointer;
        max-width: 360px;
      }
      .toast.error {
        border-color: var(--danger-border);
        color: var(--danger);
      }
    `,
  ],
})
export class ToastsComponent {
  readonly toasts = inject(ToastService);
}
