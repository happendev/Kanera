import { ChangeDetectionStrategy, Component, computed, input, output, signal } from "@angular/core";
import { PANEL_INPUT_STYLES } from "./anchored-panel";
import { AutofocusDirective } from "./autofocus.directive";
import { AvatarComponent } from "./avatar.component";

/** One selectable row. Icons/colours/avatars mirror how the entity renders elsewhere in the app. */
export interface PickerOption {
  id: string;
  label: string;
  /** Secondary line. The disambiguator when several options share a name across workspaces. */
  hint?: string | null;
  /** Tabler icon name without the `ti-` prefix. */
  icon?: string | null;
  /** Shared colour token name (e.g. "blue"), applied to the icon or dot. */
  color?: string | null;
  /** Render a colour dot instead of an icon (labels, and lists that carry only a colour). */
  dot?: boolean;
  avatarUrl?: string | null;
  avatarName?: string | null;
  avatarUserId?: string | null;
  /** Nesting level, so hierarchy (organisation → workspace → board) reads at a glance. */
  depth?: number;
  /** Right-aligned meta text (counts, "Shared", …). */
  trailing?: string | null;
  disabled?: boolean;
}

export interface PickerGroup {
  id: string;
  /** Group heading; omit for an ungrouped run of options. */
  label?: string | null;
  /** Tabler icon name for the heading, so a workspace/organisation group reads like the sidebar. */
  icon?: string | null;
  color?: string | null;
  options: PickerOption[];
}

/**
 * Inline, searchable, grouped option list shared by the app's pickers. It owns no placement, so it
 * can be dropped into an anchored popover (`k-anchored-picker`) or rendered as a drill-down pane
 * inside a larger panel (the global create-card popover) without duplicating row markup.
 */
@Component({
  selector: "k-picker-list",
  standalone: true,
  imports: [AutofocusDirective, AvatarComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (showSearch()) {
      <input
        class="ap-input pl-search"
        type="text"
        autofocus
        [placeholder]="searchPlaceholder()"
        [value]="query()"
        (input)="query.set($any($event.target).value)"
      />
    }
    <div class="pl-list">
      @for (group of filteredGroups(); track group.id) {
        @if (group.label) {
          <div class="pl-group">
            @if (group.icon) {
              <i class="ti ti-{{ group.icon }}" [style.color]="colorToken(group.color)"></i>
            }
            <span>{{ group.label }}</span>
          </div>
        }
        @for (option of group.options; track option.id) {
          <button
            type="button"
            class="pl-row"
            [class.is-selected]="isSelected(option.id)"
            [class.is-grouped]="!!group.label"
            [style.padding-left.px]="indentFor(group, option)"
            [disabled]="option.disabled"
            (click)="pick.emit(option.id)"
          >
            @if (option.avatarName) {
              <k-avatar
                class="pl-avatar"
                [url]="option.avatarUrl ?? null"
                [name]="option.avatarName"
                [size]="22"
                [userId]="option.avatarUserId ?? null"
              />
            } @else if (option.dot) {
              <span class="pl-dot" [style.background]="colorToken(option.color) ?? 'var(--border-strong)'"></span>
            } @else {
              <i class="ti ti-{{ option.icon || 'point' }} pl-icon" [style.color]="colorToken(option.color)"></i>
            }
            <span class="pl-text">
              <span class="pl-label">{{ option.label }}</span>
              @if (option.hint) { <small>{{ option.hint }}</small> }
            </span>
            @if (option.trailing) { <span class="pl-trailing">{{ option.trailing }}</span> }
            @if (isSelected(option.id)) { <i class="ti ti-check pl-check"></i> }
          </button>
        }
      } @empty {
        <p class="pl-empty">{{ emptyLabel() }}</p>
      }
    </div>
  `,
  styles: [
    PANEL_INPUT_STYLES,
    `
    :host {
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-height: 0;
    }

    .pl-search { flex: none; }

    .pl-list {
      display: flex;
      flex-direction: column;
      gap: 1px;
      min-height: 0;
      overflow-y: auto;
    }

    .pl-group {
      position: sticky;
      top: 0;
      z-index: 1;
      /* Sticky headings keep the current group visible while scrolling a long, deep tree, which is
         the whole point of grouping: you always know which workspace a row belongs to. */
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 4px;
      padding: 5px 8px 3px;
      color: var(--text-muted);
      background: var(--surface-overlay);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;

      &:first-child { margin-top: 0; }

      i { font-size: 13px; }

      span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    }

    .pl-row {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      height: auto;
      min-height: 30px;
      padding: 5px 8px;
      color: var(--text);
      text-align: left;
      white-space: normal;
      background: transparent;
      border: 0;
      border-radius: var(--radius-sm);
      font-size: 13px;
      cursor: pointer;
      transition: background-color 0.12s;

      /* 30px is a comfortable mouse row and an uncomfortable thumb target; every picker in the app
         is one of these lists, so the coarse-pointer floor is set once here. */
      @media (hover: none), (pointer: coarse), (any-pointer: coarse) {
        min-height: 44px;
      }

      &:hover:not(:disabled) { background: var(--surface-2); }
      &.is-selected { background: var(--surface-2); font-weight: 600; }
      &:disabled { opacity: 0.5; cursor: not-allowed; }
      &:focus-visible { outline: 2px solid var(--border-strong); outline-offset: -2px; }
    }

    /* Rows sit inset from their heading, with a hairline rail joining them, so a group visibly owns
       its rows. Without it a heading and its rows share the same left edge and the list still scans
       as flat — which is exactly what the grouping was meant to fix. The rail stays at one depth so
       nested rows (a board under its workspace) read as a further step in, not a second tree. */
    .pl-row.is-grouped {
      position: relative;

      &::before {
        content: "";
        position: absolute;
        top: -1px;
        bottom: 0;
        left: 13px;
        width: 1px;
        background: var(--border);
      }
    }

    .pl-icon {
      flex: 0 0 16px;
      width: 16px;
      color: var(--text-muted);
      font-size: 15px;
      text-align: center;
    }

    .pl-dot {
      flex: 0 0 12px;
      width: 12px;
      height: 12px;
      border-radius: 50%;
    }

    .pl-avatar { flex: none; }

    .pl-text {
      display: grid;
      flex: 1;
      min-width: 0;
    }

    .pl-label {
      overflow: hidden;
      line-height: 1.35;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* The hint is a sentence, not a name: wrap it over up to two lines rather than clipping it to
       one. A truncated half-sentence reads as broken layout, and the row is free to grow. */
    .pl-text small {
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      overflow: hidden;
      color: var(--text-muted);
      font-size: 11px;
      font-weight: 400;
      line-height: 1.35;
    }

    .pl-trailing {
      flex: none;
      color: var(--text-muted);
      font-size: 11px;
    }

    .pl-check {
      flex: none;
      color: var(--text);
      font-size: 14px;
    }

    .pl-empty {
      margin: 0;
      padding: 10px 4px;
      color: var(--text-muted);
      font-size: 12px;
      text-align: center;
    }
  `,
  ],
})
export class PickerListComponent {
  readonly groups = input<PickerGroup[]>([]);
  readonly selectedIds = input<string[]>([]);
  readonly searchPlaceholder = input("Search…");
  /** Show the search box once there are at least this many options; small lists skip it. */
  readonly searchThreshold = input(8);
  readonly emptyLabel = input("Nothing to show");

  readonly pick = output<string>();

  readonly query = signal("");

  readonly showSearch = computed(() =>
    this.groups().reduce((total, group) => total + group.options.length, 0) >= this.searchThreshold()
  );

  readonly filteredGroups = computed<PickerGroup[]>(() => {
    const query = this.query().trim().toLowerCase();
    if (!query) return this.groups().filter((group) => group.options.length > 0);
    // Searching flattens the hierarchy: a matched child would otherwise hide under a filtered-out
    // parent row, so matching rows keep their group heading but drop their indentation. A query that
    // names the group itself (a workspace, say) keeps everything inside it.
    return this.groups().flatMap((group) => {
      const groupMatches = (group.label ?? "").toLowerCase().includes(query);
      const options = group.options
        .filter((option) =>
          groupMatches
          || option.label.toLowerCase().includes(query)
          || (option.hint ?? "").toLowerCase().includes(query)
        )
        .map((option) => ({ ...option, depth: 0 }));
      return options.length ? [{ ...group, options }] : [];
    });
  });

  isSelected(id: string): boolean {
    return this.selectedIds().includes(id);
  }

  /**
   * Left padding for a row: a base inset, one step in when the row sits under a group heading, then
   * one step per nesting level (organisation → workspace → board).
   */
  indentFor(group: PickerGroup, option: PickerOption): number {
    return 8 + (group.label ? 12 : 0) + (option.depth ?? 0) * 14;
  }

  colorToken(color: string | null | undefined): string | null {
    return color ? `var(--color-${color})` : null;
  }
}
