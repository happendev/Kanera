import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from "@angular/core";
import { CARD_LABEL_NAME_MAX_LENGTH } from "@kanera/shared/dto/name-limits";
import { ANCHORED_HOST_STYLES } from "../../shared/anchored-panel";
import { AnchoredPanelDirective } from "../../shared/anchored-panel.directive";
import { ListboxNav } from "../../shared/listbox-nav";
import { MatchHighlightComponent } from "../../shared/match-highlight.component";

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

/** Listbox key of the "Create label" row; label ids are UUIDs, so it cannot collide with one. */
const CREATE_KEY = "__create__";

@Component({
  selector: "k-label-picker",
  standalone: true,
  imports: [MatchHighlightComponent],
  hostDirectives: [AnchoredPanelDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="lp-panel">
      <div class="lp-head">
        <span class="lp-title" i18n="Label picker heading">Labels</span>
      </div>
      <input
        class="lp-search"
        type="text"
        placeholder="Search labels…"
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
      @if (filtered().length === 0 && !createName()) {
        <p class="lp-empty" i18n>No matching labels</p>
      }
      <div class="lp-list" role="listbox" aria-multiselectable="true" [id]="nav.listId" (keydown)="onKeydown($event)">
        @for (label of filtered(); track label.id) {
          <button
            type="button"
            class="lp-row"
            role="option"
            tabindex="-1"
            [id]="nav.optionId(label.id)"
            [attr.aria-selected]="selectedIds().includes(label.id)"
            [class.is-active]="nav.isActive(label.id)"
            [class.is-selected]="selectedIds().includes(label.id)"
            (click)="toggle.emit(label.id)"
            (pointermove)="nav.hover(label.id, $event)"
          >
            <span
              class="lp-dot"
              [style.background]="label.color ? 'var(--color-' + label.color + ')' : 'var(--border-strong)'"
            ></span>
            <span class="lp-name"><k-match-highlight [text]="label.name" [query]="query()" /></span>
            @if (selectedIds().includes(label.id)) {
              <i class="ti ti-check lp-check"></i>
            }
          </button>
        }
        @if (createName(); as name) {
          <button
            type="button"
            class="lp-row lp-create"
            role="option"
            tabindex="-1"
            aria-selected="false"
            [id]="nav.optionId(createKey)"
            [class.is-active]="nav.isActive(createKey)"
            (click)="submitCreate()"
            (pointermove)="nav.hover(createKey, $event)"
          >
            <i class="ti ti-plus lp-create-icon"></i>
            <span class="lp-name" i18n="Label picker row that creates a new workspace label from the search text and adds it to the card">Create label “{{ name // i18n(ph="name") }}”</span>
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
    }

    .lp-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--text);
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
      &:hover { background: var(--surface-hover); }
      &.is-selected { background: var(--surface-2); }
      /* Keyboard row (the pointer moves it too): hover wash plus an inset ring so it stays visible
         on an already-tinted selected row. A ring, never an edge stripe. */
      &.is-active {
        background: var(--surface-hover);
        box-shadow: inset 0 0 0 1px var(--border-strong);
      }
    }

    /* Set apart from the labels above it: it adds to the workspace rather than picking from it. */
    .lp-create {
      color: var(--text-muted);
      .lp-name { color: var(--text); }
    }

    .lp-create-icon {
      flex: 0 0 12px;
      width: 12px;
      font-size: 13px;
      text-align: center;
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
  ],
})
export class LabelPickerPopover {
  private readonly panel = inject(AnchoredPanelDirective);

  readonly labels = input.required<LabelPickerLabel[]>();
  readonly selectedIds = input<string[]>([]);
  /**
   * Offer "Create label …" for search text that names no existing label. Labels are workspace-scoped
   * and only workspace admins may create them (the API enforces it too), so the host passes the
   * viewer's workspace-admin flag; hosts that cannot create, or are cross-workspace, leave it off.
   */
  readonly canCreate = input(false);
  readonly toggle = output<string>();
  /** The trimmed name to create. The host creates the label and then applies it to the card. */
  readonly create = output<string>();
  readonly close = output<void>();

  readonly query = signal("");
  readonly createKey = CREATE_KEY;

  /**
   * Shown only for text with no case-insensitive exact match, so the row never creates a duplicate
   * of a label the user simply typed in a different case. Over-long text is not offered at all
   * rather than silently truncated into a name the user did not type.
   */
  readonly createName = computed(() => {
    if (!this.canCreate()) return null;
    const name = this.query().trim();
    if (!name || name.length > CARD_LABEL_NAME_MAX_LENGTH) return null;
    const lowered = name.toLowerCase();
    return this.labels().some((label) => label.name.trim().toLowerCase() === lowered) ? null : name;
  });

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

  /** Rows in display order: matches first, then the create row, so Enter still prefers an existing label. */
  readonly nav = new ListboxNav(() => {
    const rows = this.filtered().map((label) => ({ key: label.id }));
    return this.createName() ? [...rows, { key: CREATE_KEY }] : rows;
  });

  onQuery(value: string): void {
    this.query.set(value);
    this.nav.resetFor(value);
  }

  onKeydown(event: KeyboardEvent): void {
    this.nav.onKeydown(event, (key) => {
      if (key === CREATE_KEY) this.submitCreate();
      else this.toggle.emit(key);
    });
  }

  submitCreate(): void {
    const name = this.createName();
    if (!name) return;
    this.create.emit(name);
    // Clear the search so the list shows the new label (once it arrives) ticked among the rest, and
    // so a second Enter cannot submit the same name twice.
    this.onQuery("");
  }
}
