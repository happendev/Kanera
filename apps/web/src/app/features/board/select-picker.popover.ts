import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from "@angular/core";
import type { WireCustomFieldOption } from "@kanera/shared/events";
import { ANCHORED_HOST_STYLES } from "../../shared/anchored-panel";
import { AnchoredPanelDirective } from "../../shared/anchored-panel.directive";
import { ListboxNav } from "../../shared/listbox-nav";
import { MatchHighlightComponent } from "../../shared/match-highlight.component";
import { byPosition } from "../../shared/position-sort";

// Option picker for `select` custom fields. Single vs multi selection is decided
// by the parent: it sets the resulting value and closes the popover for single fields.
@Component({
  selector: "k-select-picker",
  standalone: true,
  imports: [MatchHighlightComponent],
  hostDirectives: [AnchoredPanelDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="lp-panel">
      <div class="lp-head">
        <span class="lp-title">{{ title() }}</span>
        @if (allowMultiple()) {
          <span class="lp-hint" i18n="Hint beside an option picker heading: several options can be chosen">Multiple</span>
        }
      </div>
      <input
        class="lp-search"
        type="text"
        placeholder="Search options…"
        i18n-placeholder
        role="combobox"
        aria-autocomplete="list"
        aria-expanded="true"
        [attr.aria-controls]="nav.listId"
        [attr.aria-activedescendant]="nav.activeDescendant()"
        [value]="query()"
        (input)="onQuery($any($event.target).value)"
        (keydown)="onKeydown($event)"
        autofocus
      />
      @if (filtered().length === 0) {
        <p class="lp-empty" i18n>No matching options</p>
      }
      <div class="lp-list" role="listbox" [attr.aria-multiselectable]="allowMultiple()" [id]="nav.listId" (keydown)="onKeydown($event)">
        @for (option of filtered(); track option.id) {
          <button
            type="button"
            class="lp-row"
            role="option"
            tabindex="-1"
            [id]="nav.optionId(option.id)"
            [attr.aria-selected]="selectedIds().includes(option.id)"
            [class.is-active]="nav.isActive(option.id)"
            [class.is-selected]="selectedIds().includes(option.id)"
            (click)="toggle.emit(option.id)"
            (pointermove)="nav.hover(option.id, $event)"
          >
            <span
              class="lp-dot"
              [style.background]="option.color ? 'var(--color-' + option.color + ')' : 'var(--border-strong)'"
            ></span>
            <span class="lp-name"><k-match-highlight [text]="option.label" [query]="query()" /></span>
            @if (selectedIds().includes(option.id)) {
              <i class="ti ti-check lp-check"></i>
            }
          </button>
        }
      </div>
      @if (selectedIds().length) {
        <button type="button" class="lp-clear" (click)="clear.emit()" i18n="Button: clear the selected options">Clear</button>
      }
    </div>
  `,
  styles: [
    ANCHORED_HOST_STYLES,
    `
    .lp-panel {
      background: var(--surface-overlay);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-lg);
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
      justify-content: space-between;
    }

    .lp-title {
      font-size: var(--text-sm);
      font-weight: 600;
      color: var(--text);
    }

    .lp-hint {
      font-size: var(--text-xs);
      color: var(--text-muted);
    }

    .lp-search {
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text);
      padding: 6px 8px;
      font-size: var(--text-base);
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
      font-size: var(--text-sm);
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
      &:hover { background: var(--surface-hover); }
      &.is-selected { background: var(--surface-2); }
      /* Keyboard row (the pointer moves it too): hover wash plus an inset ring so it stays visible
         on an already-tinted selected row. A ring, never an edge stripe. */
      &.is-active {
        background: var(--surface-hover);
        box-shadow: inset 0 0 0 1px var(--border-strong);
      }
    }

    .lp-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      flex: 0 0 12px;
    }

    .lp-name {
      flex: 1;
      font-size: var(--text-base);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .lp-check {
      color: var(--accent, var(--text));
      font-size: var(--text-md);
    }

    .lp-clear {
      background: transparent;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text-muted);
      padding: 5px 8px;
      font-size: var(--text-sm);
      cursor: pointer;
      &:hover { background: var(--surface-hover); color: var(--text); }
    }
  `,
  ],
})
export class SelectPickerPopover {
  private readonly panel = inject(AnchoredPanelDirective);

  readonly options = input.required<WireCustomFieldOption[]>();
  readonly selectedIds = input<string[]>([]);
  readonly allowMultiple = input(false);
  readonly title = input($localize`:Default heading of a custom field option picker:Options`);
  readonly toggle = output<string>();
  readonly clear = output<void>();
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
    const sorted = [...this.options()].sort(byPosition);
    if (!q) return sorted;
    return sorted.filter((o) => o.label.toLowerCase().includes(q));
  });

  readonly nav = new ListboxNav(() => this.filtered().map((option) => ({ key: option.id })));

  onQuery(value: string): void {
    this.query.set(value);
    this.nav.resetFor(value);
  }

  onKeydown(event: KeyboardEvent): void {
    this.nav.onKeydown(event, (key) => this.toggle.emit(key));
  }
}
