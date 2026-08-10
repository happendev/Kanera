import { ChangeDetectionStrategy, Component, computed, input, output, signal } from "@angular/core";
import { AnchoredPanelDirective } from "../../shared/anchored-panel.directive";

export type TokenMultiSelectOption = {
  id: string;
  name: string;
  /** Resolved CSS colour for the swatch, e.g. `var(--color-teal)`. Omitted options render no dot. */
  color?: string | null;
};

/**
 * Searchable picker for the small coloured-token vocabularies in the automation editor: card labels
 * and custom-field select options. Replaces the native `<select multiple>` listboxes those two used
 * to render, which were the only ctrl-click multi-selects left in the product.
 *
 * `max` caps the selection; `max === 1` makes it single-select (picking replaces) so a
 * populate_custom_field action on a non-multiple field cannot build a selection the API will reject.
 */
@Component({
  selector: "k-token-multi-select-dropdown",
  standalone: true,
  imports: [AnchoredPanelDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="tms">
      <button #trigger type="button" class="tms-trigger" [class.is-open]="open()" [class.is-empty]="selectedOptions().length === 0" (click)="toggleOpen()" [attr.aria-expanded]="open()" aria-haspopup="listbox" [attr.aria-label]="ariaLabel() || placeholder()">
        @if (selectedOptions().length) {
          <span class="tms-swatches" aria-hidden="true">
            @for (option of selectedOptions().slice(0, 3); track option.id) {
              @if (option.color) { <span class="tms-dot" [style.background]="option.color"></span> }
            }
          </span>
        } @else {
          <i [class]="'ti ' + icon()"></i>
        }
        <span class="tms-label">{{ selectedLabel() }}</span>
        <i class="ti ti-chevron-down tms-chevron"></i>
      </button>

      @if (open()) {
        <div
          class="tms-panel"
          kAnchoredPanel
          [apAnchor]="trigger"
          [apPlacement]="placement"
          (apDismissed)="open.set(false)"
        >
          @if (options().length > 7) {
            <input
              class="tms-search"
              type="text"
              [placeholder]="searchPlaceholder()"
              [value]="query()"
              (input)="query.set($any($event.target).value)"
            />
          }
          <div class="tms-list" role="listbox" [attr.aria-multiselectable]="max() !== 1">
            @if (filteredOptions().length === 0) {
              <p class="tms-empty">{{ emptyMessage() }}</p>
            }
            @for (option of filteredOptions(); track option.id) {
              <button type="button" class="tms-row" [class.is-selected]="isSelected(option.id)" (click)="toggle(option.id)" role="option" [attr.aria-selected]="isSelected(option.id)">
                <span class="tms-dot" [style.background]="option.color || 'var(--border-strong)'"></span>
                <span class="tms-name">{{ option.name }}</span>
                @if (isSelected(option.id)) {
                  <i class="ti ti-check tms-check"></i>
                }
              </button>
            }
          </div>
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
    .tms-trigger {
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

      &:hover,
      &.is-open {
        border-color: var(--border-strong);
        background: var(--surface-hover);
      }

      &:focus-visible {
        border-color: var(--accent, var(--border-strong));
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent, var(--border-strong)) 20%, transparent);
        outline: none;
      }

      &.is-empty .tms-label {
        color: var(--text-muted);
      }
    }

    .tms-trigger > i:not(.tms-chevron) {
      color: var(--text-muted);
      font-size: 15px;
    }

    .tms-swatches {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      flex: 0 0 auto;
    }

    .tms-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      flex: 0 0 auto;
    }

    .tms-label {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .tms-chevron {
      color: var(--text-muted);
      font-size: 14px;
      flex: 0 0 auto;
    }

    .tms-panel {
      width: var(--ap-width, 280px);
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 8px;
      border: 1px solid var(--border-strong);
      border-radius: var(--radius);
      background: var(--surface-overlay);
      box-shadow: 0 12px 28px rgba(0, 0, 0, 0.22);
      overflow: hidden;
    }

    .tms-search {
      height: 32px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--surface-2);
      color: var(--text);
      padding: 0 8px;
      font-size: 13px;
      outline: none;

      &:focus {
        border-color: var(--accent, var(--text));
      }
    }

    .tms-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-height: 0;
      overflow-y: auto;
    }

    .tms-row {
      width: 100%;
      min-height: 34px;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      border: 0;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--text);
      cursor: pointer;
      text-align: left;
      font-size: 13px;

      &:hover,
      &.is-selected {
        background: var(--surface-2);
      }
    }

    .tms-name {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .tms-check {
      color: var(--accent, var(--text));
      font-size: 15px;
      flex: 0 0 auto;
    }

    .tms-empty {
      margin: 0;
      padding: 10px 6px;
      text-align: center;
      color: var(--text-muted);
      font-size: 12px;
    }
  `,
})
export class TokenMultiSelectDropdownComponent {
  readonly options = input.required<TokenMultiSelectOption[]>();
  readonly selectedIds = input<string[]>([]);
  readonly placeholder = input("Choose");
  readonly icon = input("ti-tag");
  readonly searchPlaceholder = input("Search...");
  readonly emptyMessage = input("Nothing to choose from");
  readonly ariaLabel = input<string | null>(null);
  /** null = unbounded. 1 turns the control into a single-select. */
  readonly max = input<number | null>(null);
  readonly selectedIdsChange = output<string[]>();

  readonly open = signal(false);
  readonly query = signal("");
  readonly placement = { width: 280, maxHeight: 320, minHeight: 160, gap: 4, margin: 8 } as const;

  readonly selectedOptions = computed(() => {
    const selected = new Set(this.selectedIds());
    return this.options().filter((option) => selected.has(option.id));
  });

  readonly selectedLabel = computed(() => {
    const options = this.selectedOptions();
    if (options.length === 0) return this.placeholder();
    if (options.length <= 2) return options.map((option) => option.name).join(", ");
    return `${options[0]?.name}, ${options[1]?.name} +${options.length - 2}`;
  });

  readonly filteredOptions = computed(() => {
    const q = this.query().trim().toLowerCase();
    if (!q) return this.options();
    return this.options().filter((option) => option.name.toLowerCase().includes(q));
  });

  isSelected(id: string): boolean {
    return this.selectedIds().includes(id);
  }

  toggleOpen() {
    this.open.update((value) => !value);
  }

  toggle(id: string) {
    const selected = this.selectedIds();
    if (selected.includes(id)) {
      this.selectedIdsChange.emit(selected.filter((candidate) => candidate !== id));
      return;
    }
    const max = this.max();
    if (max === 1) {
      // Single-select: replace rather than append, and close so the choice reads as committed.
      this.selectedIdsChange.emit([id]);
      this.open.set(false);
      return;
    }
    if (max !== null && selected.length >= max) return;
    this.selectedIdsChange.emit([...selected, id]);
  }
}
