import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from "@angular/core";
import { ANCHORED_HOST_STYLES, anchoredSheetStyles } from "../../shared/anchored-panel";
import { AnchoredPanelDirective } from "../../shared/anchored-panel.directive";

/**
 * Only what the picker renders and sorts by. Structural rather than the `CardLabel` row so the
 * cross-board work catalog — which carries no row timestamps — can drive the same picker.
 */
export interface LabelPickerLabel {
  id: string;
  name: string;
  color: string | null;
  position: string;
}

@Component({
  selector: "k-label-picker",
  standalone: true,
  imports: [],
  hostDirectives: [AnchoredPanelDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="lp-panel">
      <div class="lp-head">
        <span class="lp-title">Labels</span>
      </div>
      <input
        class="lp-search"
        type="text"
        placeholder="Search labels…"
        [value]="query()"
        (input)="query.set($any($event.target).value)"
        autofocus
      />
      <div class="lp-list">
        @if (filtered().length === 0) {
          <p class="lp-empty">No matching labels</p>
        }
        @for (label of filtered(); track label.id) {
          <button
            type="button"
            class="lp-row"
            [class.is-selected]="selectedIds().includes(label.id)"
            (click)="toggle.emit(label.id)"
          >
            <span
              class="lp-dot"
              [style.background]="label.color ? 'var(--color-' + label.color + ')' : 'var(--border-strong)'"
            ></span>
            <span class="lp-name">{{ label.name }}</span>
            @if (selectedIds().includes(label.id)) {
              <i class="ti ti-check lp-check"></i>
            }
          </button>
        }
      </div>
    </div>
  `,
  styles: [
    ANCHORED_HOST_STYLES,
    `
    .lp-panel {
      background: var(--surface-overlay);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-lg);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
      padding: 10px;
      width: 100%;
      max-height: var(--ap-max-height, 340px);
      overflow: hidden;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .lp-head {
      display: flex;
      align-items: center;
    }

    .lp-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--text);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .lp-search {
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text);
      padding: 6px 8px;
      font-size: 13px;
      outline: none;
      &:focus { border-color: var(--accent, var(--text)); }
    }

    .lp-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
      /* min-height: 0 lets the list absorb the panel's --ap-max-height clamp on a short viewport. */
      min-height: 0;
      max-height: 280px;
      overflow-y: auto;
    }

    .lp-empty {
      color: var(--text-muted);
      font-size: 12px;
      margin: 0;
      padding: 8px 4px;
      text-align: center;
    }

    .lp-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      background: transparent;
      border: none;
      border-radius: var(--radius-sm);
      cursor: pointer;
      color: var(--text);
      text-align: left;
      width: 100%;
      transition: background-color 0.12s;
      &:hover { background: var(--surface-2); }
      &.is-selected { background: var(--surface-2); }
    }

    .lp-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      flex: 0 0 12px;
    }

    .lp-name {
      flex: 1;
      font-size: 13px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .lp-check {
      color: var(--accent, var(--text));
      font-size: 14px;
    }
  `,
    anchoredSheetStyles("lp-panel"),
  ],
})
export class LabelPickerPopover {
  private readonly panel = inject(AnchoredPanelDirective);

  readonly labels = input.required<LabelPickerLabel[]>();
  readonly selectedIds = input<string[]>([]);
  readonly toggle = output<string>();
  readonly close = output<void>();

  readonly query = signal("");

  constructor() {
    this.panel.configure({
      placement: () => ({ align: "end", width: 260, maxHeight: 340 }),
      onDismiss: () => this.close.emit(),
    });
  }

  readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    const sorted = [...this.labels()].sort((a, b) =>
      Number(a.position) - Number(b.position),
    );
    if (!q) return sorted;
    return sorted.filter((l) => l.name.toLowerCase().includes(q));
  });
}
