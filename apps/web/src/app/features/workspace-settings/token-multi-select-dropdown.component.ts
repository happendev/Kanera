import { ChangeDetectionStrategy, Component, computed, input, output, signal } from "@angular/core";
import { AnchoredPanelDirective } from "../../shared/anchored-panel.directive";
import { PickerListComponent, type PickerGroup } from "../../shared/picker-list.component";

export type TokenMultiSelectOption = {
  id: string;
  name: string;
  /** Shared colour token name, e.g. `teal` — not a resolved CSS value. Omitted options fall back
   * to a neutral swatch, matching how every other picker in the app renders a colourless row. */
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
  imports: [AnchoredPanelDirective, PickerListComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="tms">
      <button #trigger type="button" class="tms-trigger" [class.is-open]="open()" [class.is-empty]="selectedOptions().length === 0" (click)="toggleOpen()" [attr.aria-expanded]="open()" aria-haspopup="listbox" [attr.aria-label]="ariaLabel() || placeholder()">
        @if (selectedOptions().length) {
          <span class="tms-swatches" aria-hidden="true">
            @for (option of selectedOptions().slice(0, 3); track option.id) {
              @if (option.color) { <span class="tms-dot" [style.background]="swatch(option.color)"></span> }
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
          <k-picker-list
            [groups]="pickerGroups()"
            [selectedIds]="selectedIds()"
            [searchPlaceholder]="searchPlaceholder()"
            [emptyLabel]="emptyMessage()"
            (pick)="toggle($event)"
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

  /**
   * Rows for `k-picker-list`, which owns the search, row markup, selected tick and empty state.
   * `dot: true` on every row, colour or not, keeps the swatch column aligned — a colourless option
   * renders the neutral dot rather than shifting its label left past its neighbours.
   *
   * The default `searchThreshold` of 8 is deliberately left alone: it matches the "more than seven
   * options" rule this control used before, so short vocabularies still open straight onto the list.
   */
  readonly pickerGroups = computed<PickerGroup[]>(() => [{
    id: "tokens",
    options: this.options().map((option) => ({
      id: option.id,
      label: option.name,
      color: option.color ?? null,
      dot: true,
    })),
  }]);

  /** Resolve a colour token for the trigger's own swatch stack, which is outside the picker list. */
  swatch(color: string | null | undefined): string {
    return color ? `var(--color-${color})` : "var(--border-strong)";
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
