import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { UpdatesService } from "../core/updates/updates.service";

@Component({
  selector: "a-update-prompt",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (updates.updateAvailable()) {
      <div class="update-toast" role="status">
        <i class="ti ti-refresh"></i>
        <span>Update available</span>
        <button class="btn btn-sm" type="button" (click)="updates.applyUpdate()">Refresh</button>
      </div>
    }
  `,
  styles: [
    `
      .update-toast {
        position: fixed;
        right: 16px;
        top: 16px;
        z-index: 1001;
        display: flex;
        align-items: center;
        gap: 10px;
        max-width: calc(100vw - 32px);
        padding: 10px 12px;
        border: 1px solid var(--border-strong);
        border-radius: var(--radius);
        background: var(--surface);
        color: var(--text);
        box-shadow: var(--shadow-sm);
        font-size: 13px;
      }

      .update-toast span {
        min-width: 0;
      }

      .btn {
        flex: 0 0 auto;
      }
    `,
  ],
})
export class UpdatePromptComponent {
  readonly updates = inject(UpdatesService);
}
