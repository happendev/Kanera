import { ChangeDetectionStrategy, Component, input, output, signal } from "@angular/core";
import { AnchoredPanelDirective } from "./anchored-panel.directive";
import type { AnchoredPanelPlacement } from "./anchored-panel";
import { PickerListComponent, type PickerGroup } from "./picker-list.component";

/**
 * The trigger-and-panel shell every searchable multi-select in the settings pages shares: a
 * select-shaped button carrying a projected adornment (icon, avatar stack or colour dots) and the
 * truncated selection label, with the anchored `k-picker-list` panel below it.
 *
 * Wrappers own the vocabulary: they build `groups`, compute `label`, and decide what a pick does
 * (toggle, replace for single-select, respect a cap). `pick` is emitted for every row press; a
 * wrapper that commits a single choice can call `close()` so the choice reads as final.
 */
@Component({
  selector: "k-multi-select-dropdown",
  standalone: true,
  imports: [AnchoredPanelDirective, PickerListComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="msd">
      <button #trigger type="button" class="msd-trigger" [class.is-open]="open()" [class.is-empty]="empty()" (click)="toggleOpen()" [attr.aria-expanded]="open()" aria-haspopup="listbox" [attr.aria-label]="ariaLabel()">
        <ng-content />
        <span class="msd-label">{{ label() }}</span>
        <i class="ti ti-chevron-down msd-chevron"></i>
      </button>

      @if (open()) {
        <div
          class="msd-panel"
          kAnchoredPanel
          [apAnchor]="trigger"
          [apPlacement]="placement()"
          (apDismissed)="open.set(false)"
        >
          <k-picker-list
            [groups]="groups()"
            [selectedIds]="selectedIds()"
            [searchThreshold]="searchThreshold()"
            [searchPlaceholder]="searchPlaceholder()"
            [emptyLabel]="emptyLabel()"
            (pick)="pick.emit($event)"
          />
        </div>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }

    /* --field-bg lets the host seat this trigger at the same depth as its native selects; hosts that
       do not set it keep the previous --surface-2 fill. */
    .msd-trigger {
      width: 100%;
      height: 34px;
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      padding: 0 9px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--field-bg, var(--surface-2));
      color: var(--text);
      cursor: pointer;
      text-align: left;
      font-size: 13px;

      &.is-open {
        border-color: var(--border-strong);
        background: var(--surface-hover);
      }

      &:focus-visible {
        border-color: var(--accent, var(--border-strong));
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent, var(--border-strong)) 20%, transparent);
        outline: none;
      }

      &.is-empty .msd-label {
        color: var(--text-muted);
      }
    }

    /* Projected adornments: a plain icon is muted like a select's own icon; stacks and swatch rows
       are laid out by the wrapper's own styles. */
    .msd-trigger > ::ng-deep i.ti:not(.msd-chevron) {
      color: var(--text-muted);
      font-size: 15px;
    }

    .msd-label {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .msd-chevron {
      color: var(--text-muted);
      font-size: 14px;
      flex: 0 0 auto;
    }

    .msd-panel {
      width: var(--ap-width, 320px);
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 8px;
      border: 1px solid var(--border-strong);
      border-radius: var(--radius);
      background: var(--surface-overlay);
      box-shadow: var(--shadow-lg);
      overflow: hidden;
    }
  `,
})
export class MultiSelectDropdownComponent {
  readonly groups = input.required<PickerGroup[]>();
  readonly selectedIds = input<string[]>([]);
  /** The trigger text: the selection summary, or the placeholder when nothing is selected. */
  readonly label = input.required<string>();
  /** Mutes the label when it is only the placeholder. */
  readonly empty = input(false);
  readonly placement = input<AnchoredPanelPlacement>({ width: 320, maxHeight: 340, minHeight: 180, gap: 4, margin: 8 });
  /** Passed through to `k-picker-list`; the default matches its own (search only for longer lists). */
  readonly searchThreshold = input(8);
  readonly searchPlaceholder = input("Search...");
  readonly emptyLabel = input("Nothing to choose from");
  readonly ariaLabel = input<string | null>(null);
  readonly pick = output<string>();

  readonly open = signal(false);

  toggleOpen() {
    this.open.update((value) => !value);
  }

  close() {
    this.open.set(false);
  }
}
