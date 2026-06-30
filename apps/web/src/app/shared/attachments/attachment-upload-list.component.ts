import { ChangeDetectionStrategy, Component, input, output } from "@angular/core";
import type { UploadItem } from "./attachment-upload-queue.service";

/**
 * Presentational list of in-flight / failed attachment uploads. Shared by the card-detail and
 * note-editor dropzones so the progress + retry UX is identical in both. Styling is component-scoped
 * (the two host panels use different `attach-`/`ne-attach-` class prefixes) and emits ids upward;
 * all queue state lives in AttachmentUploadQueue.
 */
@Component({
  selector: "k-attachment-upload-list",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (items().length) {
    <ul class="upl-list">
      @for (item of items(); track item.id) {
      <li class="upl-row" [class.is-error]="item.status === 'error'">
        <i [class]="item.status === 'error' ? 'ti ti-alert-circle' : 'ti ' + item.icon"></i>
        <div class="upl-body">
          <div class="upl-name-row">
            <span class="upl-name" [title]="item.fileName">{{ item.fileName }}</span>
            @if (item.status === 'uploading') {
            <span class="upl-pct">{{ item.progress }}%</span>
            }
          </div>
          @if (item.status === 'uploading') {
          <div class="upl-track" role="progressbar" [attr.aria-valuenow]="item.progress" aria-valuemin="0" aria-valuemax="100">
            <div class="upl-fill" [style.width.%]="item.progress"></div>
          </div>
          } @else {
          <span class="upl-error">{{ item.error }}</span>
          }
        </div>
        @if (item.status === 'error') {
        @if (item.retryable) {
        <button type="button" class="upl-btn" (click)="retry.emit(item.id)" title="Retry upload">
          <i class="ti ti-refresh"></i> Retry
        </button>
        }
        <button type="button" class="upl-btn icon" (click)="dismiss.emit(item.id)" title="Dismiss">
          <i class="ti ti-x"></i>
        </button>
        }
      </li>
      }
    </ul>
    }
  `,
  styles: [
    `
      .upl-list {
        list-style: none;
        margin: 8px 0 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .upl-row {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 10px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm, 6px);
        background: var(--surface-subtle, transparent);
        font-size: 12px;
      }
      .upl-row.is-error {
        border-color: color-mix(in srgb, var(--danger, #d33) 45%, var(--border));
      }
      .upl-row > .ti {
        flex: none;
        font-size: 16px;
        color: var(--muted, #888);
      }
      .upl-row.is-error > .ti {
        color: var(--danger, #d33);
      }
      .upl-body {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .upl-name-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .upl-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .upl-pct {
        flex: none;
        font-variant-numeric: tabular-nums;
        color: var(--muted, #888);
      }
      .upl-track {
        height: 4px;
        border-radius: 999px;
        background: var(--surface-hover, color-mix(in srgb, var(--border) 60%, transparent));
        overflow: hidden;
      }
      .upl-fill {
        height: 100%;
        border-radius: inherit;
        background: var(--accent, #4b7bec);
        transition: width 0.15s ease;
      }
      .upl-error {
        color: var(--danger, #d33);
      }
      .upl-btn {
        flex: none;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 4px 8px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm, 6px);
        background: var(--surface, transparent);
        color: inherit;
        font-size: 12px;
        cursor: pointer;
      }
      .upl-btn:hover {
        background: var(--surface-hover, var(--surface-subtle));
      }
      .upl-btn.icon {
        padding: 4px 6px;
      }
    `,
  ],
})
export class AttachmentUploadListComponent {
  readonly items = input.required<UploadItem[]>();
  readonly retry = output<string>();
  readonly dismiss = output<string>();
}
