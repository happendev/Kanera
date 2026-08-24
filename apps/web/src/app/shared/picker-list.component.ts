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
  /**
   * Tabler icon name without the `ti-` prefix. Omit it and the row renders no icon slot at all,
   * which is what a row wants when its icon would only repeat its group heading's — a column of
   * card titles all starting at one left edge is far easier to scan than one indented behind a
   * meaningless bullet.
   */
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
  /**
   * Quiet line *above* the label — a card key, a reference, a code. Separate from `hint` so a row can
   * carry both an identifier and a description, and so the identifier sits where the card tile, the
   * notifications drawer and the Up next row already put it.
   */
  overline?: string | null;
  /** Right-aligned meta text (counts, "Shared", a due date …). */
  trailing?: string | null;
  /**
   * Render the trailing meta as a chip, the way a due date renders on a card tile and on an Up next
   * row. Opt-in because a plain count ("3") in a chip reads as a badge nobody asked for.
   */
  trailingChip?: boolean;
  /** Colours the trailing meta when it carries pressure rather than a plain count. */
  trailingTone?: "muted" | "warning" | "danger";
  disabled?: boolean;
}

export interface PickerGroup {
  id: string;
  /** Group heading; omit for an ungrouped run of options. */
  label?: string | null;
  /** Tabler icon name for the heading, so a workspace/organisation group reads like the sidebar. */
  icon?: string | null;
  color?: string | null;
  /**
   * An outer heading this group belongs to, rendered once above the first of a consecutive run that
   * names the same one — the second level of grouping (board › list, workspace › board) without
   * repeating the outer name on every inner heading. Consecutive is enough because callers hand the
   * list over already ordered; a caller that interleaves parents gets a repeated heading, which is
   * the honest rendering of that order.
   */
  parent?: { id: string; label: string; icon?: string | null; color?: string | null } | null;
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
      @for (group of renderedGroups(); track group.id) {
        @if (group.showParent && group.parent; as parent) {
          <div class="pl-parent">
            @if (parent.icon) {
              <i class="ti ti-{{ parent.icon }}" [style.color]="colorToken(parent.color)"></i>
            }
            <span>{{ parent.label }}</span>
          </div>
        }
        @if (group.label) {
          <div class="pl-group" [class.has-parent]="!!group.parent">
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
            [class.is-nested]="!!group.parent"
            [class.has-overline]="!!option.overline"
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
            } @else if (option.icon) {
              <i class="ti ti-{{ option.icon }} pl-icon" [style.color]="colorToken(option.color)"></i>
            }
            <span class="pl-text">
              @if (option.overline) { <small class="pl-overline">{{ option.overline }}</small> }
              <span class="pl-label">{{ option.label }}</span>
              @if (option.hint) { <small>{{ option.hint }}</small> }
            </span>
            @if (option.trailing) {
              <span
                class="pl-trailing"
                [class.is-chip]="option.trailingChip"
                [class.is-warning]="option.trailingTone === 'warning'"
                [class.is-danger]="option.trailingTone === 'danger'"
              >{{ option.trailing }}</span>
            }
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
      flex: none;
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

    /* Two sticky levels would have to know each other's exact height to stack, so the *outer*
       heading is the one that sticks: it is the coarser fact, and losing it is what leaves you
       scrolling a list of lists with no idea which board you are in. The inner heading sits a step
       in from it, directly above its own two or three rows, where it needs no stickiness. */
    .pl-group.has-parent {
      position: static;
      /* Enough to separate this list's rows from the previous list's, but a step smaller than the
         gap above a board heading, so the two levels stay tellable apart. */
      margin-top: 7px;
      padding-left: 20px;
      color: var(--text-muted);
      background: none;
      font-size: 10.5px;
      font-weight: 600;
      letter-spacing: 0.02em;
      text-transform: none;
    }

    /* A board heading and its first list belong together: the gap goes *above* the board, not
       between it and the list it introduces. */
    .pl-parent + .pl-group.has-parent { margin-top: 1px; }

    .pl-parent {
      position: sticky;
      top: 0;
      z-index: 2;
      display: flex;
      flex: none;
      align-items: center;
      gap: 6px;
      /* Weight, a rule and air — deliberately no tinted fill. A filled heading band and a filled
         hover row are two filled bands a shade apart, and the reader cannot tell which one the
         pointer is on. The hovered row is the only thing in this list that fills, so hover is never
         ambiguous. The background is still painted, opaquely and in the panel's own colour, because
         rows scroll underneath a sticky heading. */
      margin-top: 12px;
      min-height: 26px;
      padding: 6px 8px;
      color: var(--text);
      background: var(--surface-overlay);
      border-bottom: 1px solid var(--border);
      font-size: 11.5px;
      font-weight: 700;
      letter-spacing: 0.02em;

      &:first-child { margin-top: 0; }

      i { font-size: 14px; }

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
      /* Never compresses. These are flex items in a height-constrained scrolling column, so they are
         shrinkable, and min-height replaces a flex item's automatic minimum size — which means the
         column happily squeezes a row down to 30px and lets its own text render *outside* its box.
         A two-line row then loses its second line from the hover highlight, and the pointer appears
         to be highlighting the row above. The list scrolls; the rows do not give. The board's own
         k-priority-queue .panel-row carries this rule for the same reason. */
      flex: none;
      min-height: 30px;
      padding: 5px 8px;
      /* Rows are separated by 1px, so a two-line row has to buy its own breathing room or the line
         above and the line below crowd equally and the pairing goes ambiguous. */
      &.has-overline {
        align-items: flex-start;
        padding-top: 7px;
        padding-bottom: 7px;
      }
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

      /* --surface-2 against the panel's --surface-overlay is a two-value difference in dark mode:
         technically a hover state, practically invisible. These rows are the panel's whole content,
         so the row under the pointer has to be obvious. */
      &:hover:not(:disabled) { background: var(--surface-hover); }
      &.is-selected { background: var(--surface-3); font-weight: 600; }
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

    /* One step further in than a single-level group, so the inner heading visibly owns its rows
       instead of sharing their left edge — the rail moves with them. */
    .pl-row.is-nested::before { left: 21px; }

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

    /* Above the label, at the same size and colour as the hint below it, so the row reads
       identifier → name → description top to bottom. It shares its line with the trailing meta,
       which is why that meta aligns to the top of the row rather than its centre: the pair reads as
       one quiet meta line with the title owning the full width beneath it — the anatomy of an Up next
       row and of the card tile before it. */
    /* Qualified with the element name, not written as a bare class: the .pl-text small rule above is
       a class *and* a type selector, so it out-specifies a bare .pl-overline and silently kept this
       at the hint's 11px. (No backticks in these comments — the block is a template literal.) */
    .pl-text small.pl-overline {
      margin-bottom: 2px;
      /* Smaller than the hint: a reference is for confirming and searching, not for reading down the
         list. Same 10px the card tile and the Up next row give it. */
      font-size: 10px;
      font-variant-numeric: tabular-nums;
      letter-spacing: 0.03em;
      opacity: 0.75;
    }

    .pl-trailing {
      flex: none;
      color: var(--text-muted);
      font-size: 11px;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;

      /* Pressure, not decoration: an overdue row has to be visible while scanning a long picker,
         which is the whole reason a due date is in this list at all. */
      &.is-danger { color: var(--danger); }
      &.is-warning { color: var(--color-amber, #d97706); }
    }

    /* The same chip a due date wears on an Up next row and a board tile, at the same 10px/600 — a
       picker that helps you choose what to do next has to show due pressure the way every other
       surface shows it, or the two have to be re-learned against each other. */
    .pl-trailing.is-chip {
      padding: 3px 7px;
      font-size: 10px;
      font-weight: 600;
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);

      &.is-danger {
        background: var(--danger-bg);
        border-color: transparent;
      }

      &.is-warning {
        background: color-mix(in srgb, var(--color-amber, #d97706) 12%, transparent);
        border-color: transparent;
      }
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
      const groupMatches = (group.label ?? "").toLowerCase().includes(query)
        || (group.parent?.label ?? "").toLowerCase().includes(query);
      // Everything the row renders is searchable, including its overline and trailing meta: a card
      // key and a due date are on screen, so typing one has to narrow the list.
      const options = group.options
        .filter((option) =>
          groupMatches
          || option.label.toLowerCase().includes(query)
          || (option.hint ?? "").toLowerCase().includes(query)
          || (option.overline ?? "").toLowerCase().includes(query)
          || (option.trailing ?? "").toLowerCase().includes(query)
        )
        .map((option) => ({ ...option, depth: 0 }));
      return options.length ? [{ ...group, options }] : [];
    });
  });

  /**
   * `filteredGroups` plus the flag that says whether this group is the first of its parent's run, so
   * the outer heading is rendered once rather than above every inner group. Computed here rather than
   * in the template because the answer depends on the *previous rendered* group, which a template
   * cannot see.
   */
  readonly renderedGroups = computed(() =>
    this.filteredGroups().map((group, index, groups) => ({
      ...group,
      showParent: !!group.parent && group.parent.id !== groups[index - 1]?.parent?.id,
    }))
  );

  isSelected(id: string): boolean {
    return this.selectedIds().includes(id);
  }

  /**
   * Left padding for a row: a base inset, one step in when the row sits under a group heading, then
   * one step per nesting level (organisation → workspace → board).
   */
  indentFor(group: PickerGroup, option: PickerOption): number {
    return 8 + (group.label ? 12 : 0) + (group.parent ? 8 : 0) + (option.depth ?? 0) * 14;
  }

  colorToken(color: string | null | undefined): string | null {
    return color ? `var(--color-${color})` : null;
  }
}
