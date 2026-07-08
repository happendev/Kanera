import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from "@angular/core";
import type { WireCustomFieldOption } from "@kanera/shared/events";
import type { CustomFieldType } from "@kanera/shared/schema";
import { AvatarComponent } from "../../../shared/avatar.component";
import { DateRangePickerPopover } from "../../completed-cards/date-range-picker.popover";
import type { CfFilterCondition, CfFilterOperator, FilterValue } from "./filter.types";
import {
  OPERATORS_BY_TYPE,
  defaultOperatorFor,
  operatorHasNoValue,
  operatorUsesIds,
} from "./filter.types";
import { hasActiveFilter } from "./filter.util";
import type { AnyCustomField } from "./list-view.types";

/** Lightweight structural shapes so the bar stays decoupled from the wire/db row types. */
export interface FilterLabel {
  id: string;
  name: string;
  color: string | null;
}
export interface FilterMember {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  lastOnlineAt?: string | Date | null;
}
export interface FilterList {
  id: string;
  name: string;
  icon: string | null;
}
export interface FilterBoard {
  id: string;
  name: string;
  icon?: string | null;
}

/** Which pane of the drill-down is showing. */
type PanelView = "menu" | "labels" | "members" | "lists" | "boards" | "cf-list" | "cf-edit" | "completed";

/** A generic selectable row used by the label / member / list / board / id-set pickers. */
interface OptionRow {
  id: string;
  label: string;
  color?: string | null;
  icon?: string | null;
  member?: FilterMember;
}

/**
 * Shared filter UI for the board and assigned-work pages. Replaces the old single, fully
 * expanded dropdown (every dimension stacked at once) with a single "Filter" button whose
 * popover drills into ONE dimension's options at a time. Everything — the active-selection
 * summaries, editing, and "Clear all" — is contained inside the popover so the toolbar stays
 * uncluttered; the button just carries a count badge. The panel reflows responsively (it
 * renders inline inside the ≤1024px compact toolbar rather than floating).
 *
 * The component is controlled: the parent owns the canonical `value` and each mutation emits
 * a fresh `FilterValue` via `valueChange`. Completed-range and archived are NOT part of
 * `FilterValue` (they trigger a server reload, not a client filter) so they have their own
 * outputs, letting each page keep its existing reload path unchanged. `clearAll` is a
 * dedicated output so the page can run one comprehensive reset (and single reload) instead of
 * the component firing piecemeal completed/archived clears.
 */
@Component({
  selector: "k-filter-bar",
  standalone: true,
  imports: [AvatarComponent, DateRangePickerPopover],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="fb-wrap">
      <button type="button" class="fb-btn" [class.active]="anyActive()" (click)="toggleOpen($event)">
        <i class="ti ti-filter"></i>
        <span>Filter</span>
        @if (activeCount() > 0) { <span class="fb-badge">{{ activeCount() }}</span> }
      </button>

      @if (open()) {
        <div class="fb-panel" [class.fb-panel-flush]="view() === 'completed'" [style.--fb-panel-left.px]="panelPosition().left" [style.--fb-panel-top.px]="panelPosition().top" [style.--fb-panel-width.px]="panelPosition().width" (click)="$event.stopPropagation()">
          @switch (view()) {
            @case ('menu') {
              <div class="fb-menu">
                @if (showActivity()) {
                  <button type="button" class="fb-row" [class.active]="value().showUnreadOnly" (click)="toggleUnread()">
                    <i class="ti ti-bell fb-row-icon"></i><span class="fb-row-name">Unread</span>
                    @if (value().showUnreadOnly) { <i class="ti ti-check fb-row-check"></i> }
                  </button>
                  <button type="button" class="fb-row" [class.active]="value().showOverdueOnly" (click)="toggleOverdue()">
                    <i class="ti ti-alert-circle fb-row-icon"></i><span class="fb-row-name">Overdue</span>
                    @if (value().showOverdueOnly) { <i class="ti ti-check fb-row-check"></i> }
                  </button>
                }
                @if (labels().length) {
                  <button type="button" class="fb-row" (click)="go('labels')">
                    <i class="ti ti-tag fb-row-icon"></i><span class="fb-row-name">Labels</span>
                    @if (labelSummary()) { <span class="fb-row-summary">{{ labelSummary() }}</span> }
                    <i class="ti ti-chevron-right fb-row-caret"></i>
                  </button>
                }
                @if (showMembers() && members().length) {
                  <button type="button" class="fb-row" (click)="go('members')">
                    <i class="ti ti-user fb-row-icon"></i><span class="fb-row-name">Members</span>
                    @if (memberSummary()) { <span class="fb-row-summary">{{ memberSummary() }}</span> }
                    <i class="ti ti-chevron-right fb-row-caret"></i>
                  </button>
                }
                @if (showBoards() && boards().length) {
                  <button type="button" class="fb-row" (click)="go('boards')">
                    <i class="ti ti-clipboard-list fb-row-icon"></i><span class="fb-row-name">Board</span>
                    @if (boardSummary()) { <span class="fb-row-summary">{{ boardSummary() }}</span> }
                    <i class="ti ti-chevron-right fb-row-caret"></i>
                  </button>
                }
                @if (lists().length) {
                  <button type="button" class="fb-row" (click)="go('lists')">
                    <i class="ti ti-layout-list fb-row-icon"></i><span class="fb-row-name">Lists</span>
                    @if (listSummary()) { <span class="fb-row-summary">{{ listSummary() }}</span> }
                    <i class="ti ti-chevron-right fb-row-caret"></i>
                  </button>
                }
                @if (customFields().length) {
                  <button type="button" class="fb-row" (click)="go('cf-list')">
                    <i class="ti ti-adjustments fb-row-icon"></i><span class="fb-row-name">Custom fields</span>
                    @if (value().cfConditions.length) { <span class="fb-count">{{ value().cfConditions.length }}</span> }
                    <i class="ti ti-chevron-right fb-row-caret"></i>
                  </button>
                }
                @if (showCompleted()) {
                  <button type="button" class="fb-row" [class.active]="completedActive()" (click)="go('completed')">
                    <i class="ti ti-circle-check fb-row-icon"></i><span class="fb-row-name">Completed</span>
                    @if (completedActive()) { <span class="fb-row-summary">{{ completedLabel() }}</span> }
                    <i class="ti ti-chevron-right fb-row-caret"></i>
                  </button>
                }
                @if (showArchived()) {
                  <button type="button" class="fb-row" [class.active]="archived()" (click)="toggleArchived()">
                    <i class="ti ti-archive fb-row-icon"></i><span class="fb-row-name">Archived</span>
                    @if (archived()) { <i class="ti ti-check fb-row-check"></i> }
                  </button>
                }
                @if (anyActive()) {
                  <div class="fb-menu-foot">
                    <button type="button" class="fb-clear" (click)="clearAll.emit()">Clear all</button>
                  </div>
                }
              </div>
            }

            @case ('cf-list') {
              <div class="fb-head">
                <button type="button" class="fb-back" (click)="go('menu')" aria-label="Back"><i class="ti ti-chevron-left"></i></button>
                <span class="fb-head-title">Custom fields</span>
              </div>
              @if (value().cfConditions.length) {
                <div class="fb-list">
                  @for (cond of value().cfConditions; track $index; let i = $index) {
                    @let field = fieldById().get(cond.fieldId);
                    @if (field) {
                      <div class="fb-row fb-row-static active">
                        <button type="button" class="fb-row-main" (click)="editCondition(i)">
                          <i class="ti ti-adjustments fb-row-icon"></i>
                          <span class="fb-row-name">{{ cfSummary(cond, field) }}</span>
                        </button>
                        <button type="button" class="fb-row-x" aria-label="Remove filter" (click)="removeCondition(i)"><i class="ti ti-x"></i></button>
                      </div>
                    }
                  }
                </div>
              }
              <div class="fb-section-label">Add a field filter</div>
              <input class="fb-search" type="text" placeholder="Search fields…" [value]="query()" (input)="query.set($any($event.target).value)" />
              <div class="fb-list">
                @for (field of filteredFields(); track field.id) {
                  <button type="button" class="fb-row" (click)="addField(field.id)">
                    <i class="ti ti-{{ field.icon }} fb-row-icon"></i><span class="fb-row-name">{{ field.name }}</span>
                    <i class="ti ti-plus fb-row-caret"></i>
                  </button>
                }
                @if (filteredFields().length === 0) { <p class="fb-empty">No matching fields</p> }
              </div>
            }

            @case ('cf-edit') {
              @let cond = editingCondition();
              @let field = cond ? fieldById().get(cond.fieldId) : undefined;
              <div class="fb-head">
                <button type="button" class="fb-back" (click)="go('cf-list')" aria-label="Back"><i class="ti ti-chevron-left"></i></button>
                <span class="fb-head-title">{{ field?.name ?? 'Field' }}</span>
                <button type="button" class="fb-remove" (click)="removeEditingCondition()" aria-label="Remove filter"><i class="ti ti-trash"></i></button>
              </div>
              @if (cond && field) {
                <select class="fb-select" [value]="cond.op" (change)="changeOperator($any($event.target).value)">
                  @for (op of operatorsFor(field); track op.op) {
                    <option [value]="op.op" [selected]="op.op === cond.op">{{ op.label }}</option>
                  }
                </select>
                @if (!operatorHasNoValue(cond.op)) {
                  @if (operatorUsesIds(cond.op)) {
                    <div class="fb-list">
                      @for (row of cfIdRows(field); track row.id) {
                        <button type="button" class="fb-row" [class.active]="cfHasId(cond, row.id)" (click)="toggleCfId(row.id)">
                          @if (row.member) {
                            <k-avatar class="fb-avatar" [url]="row.member.avatarUrl" [name]="row.member.displayName" [size]="22" [userId]="row.member.userId" [workspaceId]="workspaceId()" />
                          } @else {
                            <span class="fb-dot" [style.background]="row.color ? 'var(--color-' + row.color + ')' : 'var(--border-strong)'"></span>
                          }
                          <span class="fb-row-name">{{ row.label }}</span>
                          @if (cfHasId(cond, row.id)) { <i class="ti ti-check fb-row-check"></i> }
                        </button>
                      }
                      @if (cfIdRows(field).length === 0) { <p class="fb-empty">No options</p> }
                    </div>
                  } @else if (field.type === 'number') {
                    <input class="fb-value" type="number" placeholder="Value" [value]="cond.value ?? ''" (input)="patchCf({ value: $any($event.target).value })" />
                  } @else if (field.type === 'date') {
                    @if (cond.op === 'between') {
                      <div class="fb-date-range">
                        <input class="fb-value" type="date" [value]="cond.value ?? ''" (input)="patchCf({ value: $any($event.target).value })" />
                        <span class="fb-date-sep">→</span>
                        <input class="fb-value" type="date" [value]="cond.value2 ?? ''" (input)="patchCf({ value2: $any($event.target).value })" />
                      </div>
                    } @else {
                      <input class="fb-value" type="date" [value]="cond.value ?? ''" (input)="patchCf({ value: $any($event.target).value })" />
                    }
                  } @else {
                    <input class="fb-value" type="text" placeholder="Value" [value]="cond.value ?? ''" (input)="patchCf({ value: $any($event.target).value })" />
                  }
                }
              }
            }

            @case ('completed') {
              <div class="fb-head">
                <button type="button" class="fb-back" (click)="go('menu')" aria-label="Back"><i class="ti ti-chevron-left"></i></button>
                <span class="fb-head-title">Completed</span>
              </div>
              <!-- The shared calendar is embedded inline here (see the fb-drp style) so it lives
                   inside the panel with a Back button, rather than replacing the panel. -->
              <k-date-range-picker
                class="fb-drp"
                [instant]="true"
                [from]="completedFrom()"
                [to]="completedTo()"
                (applyRange)="onCompletedApply($event)"
                (clear)="onCompletedClear()"
                (dismiss)="onCompletedDismiss()"
              />
            }

            @default {
              <!-- labels / members / lists / boards: one searchable multi-select list -->
              <div class="fb-head">
                <button type="button" class="fb-back" (click)="go('menu')" aria-label="Back"><i class="ti ti-chevron-left"></i></button>
                <span class="fb-head-title">{{ dimensionTitle() }}</span>
                @if (selectedIdsForView().length) {
                  <button type="button" class="fb-head-clear" (click)="clearDimension()">Clear</button>
                }
              </div>
              <input class="fb-search" type="text" placeholder="Search…" [value]="query()" (input)="query.set($any($event.target).value)" />
              <div class="fb-list">
                @for (row of filteredRows(); track row.id) {
                  <button type="button" class="fb-row" [class.active]="rowSelected(row.id)" (click)="toggleRow(row.id)">
                    @if (row.member) {
                      <k-avatar class="fb-avatar" [url]="row.member.avatarUrl" [name]="row.member.displayName" [size]="22" [userId]="row.member.userId" [workspaceId]="workspaceId()" [showPresence]="true" [lastOnlineAt]="row.member.lastOnlineAt" />
                    } @else if (row.icon !== undefined) {
                      <i class="ti ti-{{ row.icon ?? 'layout-list' }} fb-row-icon"></i>
                    } @else {
                      <span class="fb-dot" [style.background]="row.color ? 'var(--color-' + row.color + ')' : 'var(--border-strong)'"></span>
                    }
                    <span class="fb-row-name">{{ row.label }}</span>
                    @if (rowSelected(row.id)) { <i class="ti ti-check fb-row-check"></i> }
                  </button>
                }
                @if (filteredRows().length === 0) { <p class="fb-empty">Nothing to show</p> }
              </div>
            }
          }
        </div>
      }
    </div>
  `,
  styles: `
    :host { display: inline-flex; }
    .fb-wrap { position: relative; display: inline-flex; }

    .fb-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--surface);
      color: var(--text);
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: background-color 0.12s, border-color 0.12s;
      &:hover { background: var(--surface-2); }
      &.active { border-color: var(--accent, var(--border-strong)); color: var(--accent, var(--text)); }
      i { font-size: 15px; }
    }

    .fb-badge {
      min-width: 18px;
      height: 18px;
      padding: 0 5px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 999px;
      background: var(--accent, var(--border-strong));
      color: var(--accent-fg, var(--text));
      font-size: 11px;
      font-weight: 700;
    }

    :host-context(.lv-filter-slot) .fb-btn {
      height: 32px;
      padding: 0 10px;
      border-radius: var(--radius);
      background: transparent;
      font-weight: 500;
      &:hover { background: var(--surface-hover); border-color: var(--border-strong); }
      &.active {
        border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
        color: var(--text);
      }
    }

    :host-context(.lv-filter-slot) .fb-badge {
      height: 16px;
      min-width: 16px;
      font-size: 10px;
    }

    .fb-panel {
      position: fixed;
      top: var(--fb-panel-top, 0);
      left: var(--fb-panel-left, 0);
      z-index: 300;
      width: var(--fb-panel-width, min(320px, calc(100vw - 32px)));
      max-height: min(70vh, calc(100vh - var(--fb-panel-top, 0px) - 16px), 460px);
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 8px;
      background: var(--surface);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-lg);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
    }

    .fb-menu, .fb-list { display: flex; flex-direction: column; gap: 2px; }

    .fb-menu-foot {
      margin-top: 4px;
      padding-top: 6px;
      border-top: 1px solid var(--border);
      display: flex;
      justify-content: flex-end;
    }

    .fb-head {
      display: flex;
      align-items: center;
      gap: 6px;
      padding-bottom: 4px;
      border-bottom: 1px solid var(--border);
    }

    .fb-head-title {
      flex: 1;
      font-size: 12px;
      font-weight: 700;
      color: var(--text);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .fb-back, .fb-remove {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
      &:hover { background: var(--surface-2); color: var(--text); }
    }
    .fb-remove:hover { color: var(--danger); }

    .fb-head-clear, .fb-clear {
      border: none;
      background: transparent;
      color: var(--text-muted);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      padding: 4px 6px;
      border-radius: var(--radius-sm);
      &:hover { color: var(--text); background: var(--surface-2); }
    }
    .fb-clear:hover { color: var(--danger); }

    .fb-section-label {
      font-size: 11px;
      font-weight: 700;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      padding: 6px 4px 2px;
    }

    .fb-search, .fb-select, .fb-value {
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text);
      padding: 6px 8px;
      font-size: 13px;
      outline: none;
      width: 100%;
      &:focus { border-color: var(--accent, var(--text)); }
    }

    .fb-date-range { display: flex; align-items: center; gap: 6px; }
    .fb-date-sep { color: var(--text-muted); }

    .fb-row {
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
      font-size: 13px;
      transition: background-color 0.12s;
      &:hover { background: var(--surface-2); }
      &.active { background: var(--surface-2); }
    }

    /* An active custom-field condition row: a main (edit) button plus a remove button. */
    .fb-row-static { padding: 0; gap: 0; cursor: default; &:hover { background: var(--surface-2); } }
    .fb-row-main {
      display: flex;
      align-items: center;
      gap: 8px;
      flex: 1;
      min-width: 0;
      padding: 6px 8px;
      background: transparent;
      border: none;
      color: var(--text);
      text-align: left;
      font-size: 13px;
      cursor: pointer;
    }
    .fb-row-x {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      align-self: stretch;
      border: none;
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
      border-radius: var(--radius-sm);
      &:hover { color: var(--danger); }
    }

    .fb-row-icon { font-size: 15px; color: var(--text-muted); width: 16px; text-align: center; flex: 0 0 16px; }
    .fb-row-name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .fb-row-summary { color: var(--text-muted); font-size: 12px; max-width: 130px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .fb-row-check { color: var(--accent, var(--text)); font-size: 14px; }
    .fb-row-caret { color: var(--text-muted); font-size: 14px; }

    .fb-count {
      min-width: 18px;
      height: 18px;
      padding: 0 5px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 999px;
      background: var(--accent, var(--border-strong));
      color: var(--accent-fg, var(--text));
      font-size: 11px;
      font-weight: 700;
    }

    /* The calendar is tall, so the completed view opts out of the panel's height cap and lets
       the whole calendar (and its Clear button) show without an inner scrollbar. */
    .fb-panel-flush { overflow: auto; }

    /* Embed the shared date-range calendar inline in the panel (it is a fixed-position popover
       by default). The class selector outranks the child's own :host { position: fixed }, and
       ::ng-deep strips its standalone panel chrome + the redundant summary line so it sits flush
       and compact inside our panel. */
    .fb-drp { position: static; visibility: visible; display: block; }
    :host ::ng-deep .fb-drp .drp-panel {
      width: 100%;
      padding: 0;
      gap: 6px;
      border: none;
      border-radius: 0;
      box-shadow: none;
      background: transparent;
    }
    :host ::ng-deep .fb-drp .drp-summary { display: none; }

    .fb-dot { width: 12px; height: 12px; border-radius: 50%; flex: 0 0 12px; }
    .fb-avatar { flex: 0 0 auto; }
    .fb-empty { color: var(--text-muted); font-size: 12px; margin: 0; padding: 8px 4px; text-align: center; }

    /* In the board/assigned-work top toolbar's compact dropdown (.bf-controls) the trigger
       stretches to a full row so it stacks with the other stacked controls; the panel still
       floats at viewport level so it does not get squeezed by that layout. */
    @media (max-width: 1024px) {
      :host { display: block; width: 100%; }
      .fb-wrap { width: 100%; }
      .fb-btn { width: 100%; justify-content: flex-start; }

      /* In the list-view toolbar the filter is one inline control among many wrapping buttons,
         not a stacked dropdown row, so keep it inline-sized instead of stretching full-width. */
      :host-context(.lv-filter-slot) { display: inline-flex; width: auto; }
      :host-context(.lv-filter-slot) .fb-btn { width: auto; justify-content: center; }

      /* Match the sibling toolbar menus (Group/Sort/Aggregates), which on the compact
         flattened toolbar open as a full-width sheet anchored below the whole toolbar
         rather than a floating popover. Anchoring the panel to .lv-toolbar (which is
         position:relative) instead of the viewport requires .fb-wrap to not be a
         positioned ancestor, so drop its relative positioning here. The JS-set
         --fb-panel-* vars are simply unused in this branch. */
      :host-context(.lv-filter-slot) .fb-wrap { width: auto; position: static; }
      :host-context(.lv-filter-slot) .fb-panel {
        position: absolute;
        top: calc(100% + 4px);
        left: 8px;
        right: 8px;
        width: auto;
        max-height: min(70vh, 460px);
      }
    }
  `,
})
export class FilterBarComponent {
  private readonly hostEl = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly panelPosition = signal({ left: 16, top: 16, width: 320 });

  readonly value = input.required<FilterValue>();
  readonly closeToken = input(0);
  readonly labels = input<FilterLabel[]>([]);
  readonly members = input<FilterMember[]>([]);
  readonly lists = input<FilterList[]>([]);
  readonly boards = input<FilterBoard[]>([]);
  readonly customFields = input<AnyCustomField[]>([]);
  readonly workspaceId = input<string | null>(null);
  readonly currentUserId = input<string | null>(null);

  readonly showMembers = input(false);
  readonly showBoards = input(false);
  readonly showActivity = input(true);
  readonly showCompleted = input(false);
  readonly showArchived = input(false);

  readonly completedFrom = input("");
  readonly completedTo = input("");
  readonly completedLabel = input("");
  readonly archived = input(false);

  readonly valueChange = output<FilterValue>();
  readonly completedChange = output<{ from: string; to: string }>();
  readonly completedClear = output<void>();
  readonly archivedChange = output<boolean>();
  /** Fired by the in-panel "Clear all" so the parent runs one comprehensive reset + single reload. */
  readonly clearAll = output<void>();
  readonly opened = output<void>();

  readonly open = signal(false);
  readonly view = signal<PanelView>("menu");
  readonly query = signal("");
  /** Index into `value().cfConditions` of the condition being edited in the `cf-edit` view. */
  private readonly editIndex = signal<number | null>(null);

  readonly anyActive = computed(() => hasActiveFilter(this.value()) || this.completedActive() || this.archived());
  readonly completedActive = computed(() => !!this.completedFrom() || !!this.completedTo());

  /** Badge count: how many distinct filters are engaged (each CF condition counts once). */
  readonly activeCount = computed(() => {
    const v = this.value();
    let n = v.labelIds.length + v.memberIds.length + v.listIds.length + v.boardIds.length + v.cfConditions.length;
    if (v.showUnreadOnly) n++;
    if (v.showOverdueOnly) n++;
    if (this.completedActive()) n++;
    if (this.archived()) n++;
    return n;
  });

  private readonly labelsById = computed(() => new Map(this.labels().map((l) => [l.id, l])));
  private readonly membersById = computed(() => new Map(this.members().map((m) => [m.userId, m])));
  private readonly listsById = computed(() => new Map(this.lists().map((l) => [l.id, l])));
  private readonly boardsById = computed(() => new Map(this.boards().map((b) => [b.id, b])));
  readonly fieldById = computed(() => new Map(this.customFields().map((f) => [f.id, f])));

  constructor() {
    effect(() => {
      this.closeToken();
      if (untracked(() => this.open())) this.closePanel();
    });
  }

  // Menu-row selection summaries, so active state is visible without drilling in.
  readonly labelSummary = computed(() => this.summary(this.value().labelIds, (id) => this.labelsById().get(id)?.name));
  readonly memberSummary = computed(() => this.summary(this.value().memberIds, (id) => this.memberName(id)));
  readonly listSummary = computed(() => this.summary(this.value().listIds, (id) => this.listsById().get(id)?.name));
  readonly boardSummary = computed(() => this.summary(this.value().boardIds, (id) => this.boardsById().get(id)?.name));

  // ---- Panel navigation -------------------------------------------------------------------

  toggleOpen(event: Event) {
    event.stopPropagation();
    if (this.open()) {
      this.closePanel();
    } else {
      this.view.set("menu");
      this.query.set("");
      this.positionPanel();
      this.open.set(true);
      this.opened.emit();
    }
  }

  go(view: PanelView) {
    // Leaving the value editor without a usable operand drops the half-built condition so it
    // doesn't linger in the summary or get persisted (the matcher ignores it, but it shouldn't show).
    if (this.view() === "cf-edit" && view !== "cf-edit") this.pruneIncomplete();
    this.query.set("");
    this.view.set(view);
    this.positionPanel();
    this.open.set(true);
  }

  private positionPanel() {
    const rect = this.hostEl.nativeElement.getBoundingClientRect();
    const viewportWidth = window.innerWidth || 320;
    const viewportHeight = window.innerHeight || 480;
    const margin = 16;
    const width = Math.max(240, Math.min(320, viewportWidth - margin * 2));
    const left = Math.min(Math.max(rect.left, margin), Math.max(margin, viewportWidth - width - margin));
    const maxHeight = Math.min(viewportHeight * 0.7, 460);
    const top = Math.min(
      Math.max(rect.bottom + 6, margin),
      Math.max(margin, viewportHeight - maxHeight - margin),
    );
    this.panelPosition.set({ left, top, width });
  }

  /** Close the panel, first discarding any incomplete custom-field conditions. */
  private closePanel() {
    this.pruneIncomplete();
    this.open.set(false);
  }

  /** Close everything when the click lands outside the whole bar. */
  @HostListener("document:click", ["$event"])
  onDocumentClick(event: Event) {
    if (this.open() && !this.hostEl.nativeElement.contains(event.target as Node)) {
      this.closePanel();
    }
  }

  @HostListener("window:resize")
  @HostListener("window:scroll")
  onViewportChange() {
    if (this.open()) this.positionPanel();
  }

  @HostListener("document:keydown.escape")
  onEscape() {
    if (this.open()) this.closePanel();
  }

  // ---- Emitting ---------------------------------------------------------------------------

  private emit(patch: Partial<FilterValue>) {
    this.valueChange.emit({ ...this.value(), ...patch });
  }

  private toggleInArray(arr: string[], id: string): string[] {
    return arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id];
  }

  toggleUnread() {
    this.emit({ showUnreadOnly: !this.value().showUnreadOnly });
  }
  toggleOverdue() {
    this.emit({ showOverdueOnly: !this.value().showOverdueOnly });
  }
  toggleArchived() {
    this.archivedChange.emit(!this.archived());
  }

  onCompletedApply(range: { from: string; to: string }) {
    this.completedChange.emit(range);
    this.go("menu");
  }
  onCompletedClear() {
    this.completedClear.emit();
    this.go("menu");
  }
  /**
   * The embedded calendar emits `dismiss` on Escape / outside-click. A true outside click also
   * closes the whole panel via the host listener (which may run first), so only fall back to the
   * menu when the panel is still open — otherwise we'd re-open a panel the user just dismissed.
   */
  onCompletedDismiss() {
    if (this.open() && this.view() === "completed") this.view.set("menu");
  }

  // ---- Incomplete-condition pruning -------------------------------------------------------

  /** Drop any custom-field condition whose operator needs an operand that wasn't supplied. */
  private pruneIncomplete() {
    const conds = this.value().cfConditions;
    const kept = conds.filter((c) => this.conditionComplete(c));
    if (kept.length !== conds.length) {
      this.editIndex.set(null);
      this.emit({ cfConditions: kept });
    }
  }

  /** Whether a condition would actually filter — i.e. it has the operand its operator requires. */
  private conditionComplete(cond: CfFilterCondition): boolean {
    if (!this.fieldById().has(cond.fieldId)) return false; // field gone → drop
    if (operatorHasNoValue(cond.op)) return true; // isEmpty/checked/… need nothing
    if (operatorUsesIds(cond.op)) return (cond.ids?.length ?? 0) > 0;
    if (cond.op === "between") return !!(cond.value?.trim() || cond.value2?.trim());
    return !!cond.value?.trim();
  }

  // ---- Generic dimension picker (labels / members / lists / boards) -----------------------

  readonly dimensionTitle = computed(() => {
    switch (this.view()) {
      case "labels": return "Labels";
      case "members": return "Members";
      case "lists": return "Lists";
      case "boards": return "Board";
      default: return "";
    }
  });

  private readonly rows = computed<OptionRow[]>(() => {
    const me = this.currentUserId();
    switch (this.view()) {
      case "labels":
        return this.labels().map((l) => ({ id: l.id, label: l.name, color: l.color }));
      case "members":
        return this.members().map((m) => ({ id: m.userId, label: m.userId === me ? "Me" : m.displayName, member: m }));
      case "lists":
        return this.lists().map((l) => ({ id: l.id, label: l.name, icon: l.icon }));
      case "boards":
        return this.boards().map((b) => ({ id: b.id, label: b.name, icon: b.icon ?? null }));
      default:
        return [];
    }
  });

  readonly filteredRows = computed<OptionRow[]>(() => {
    const q = this.query().trim().toLowerCase();
    const rows = this.rows();
    return q ? rows.filter((r) => r.label.toLowerCase().includes(q)) : rows;
  });

  selectedIdsForView(): string[] {
    const v = this.value();
    switch (this.view()) {
      case "labels": return v.labelIds;
      case "members": return v.memberIds;
      case "lists": return v.listIds;
      case "boards": return v.boardIds;
      default: return [];
    }
  }

  rowSelected(id: string): boolean {
    return this.selectedIdsForView().includes(id);
  }

  toggleRow(id: string) {
    const v = this.value();
    switch (this.view()) {
      case "labels": this.emit({ labelIds: this.toggleInArray(v.labelIds, id) }); break;
      case "members": this.emit({ memberIds: this.toggleInArray(v.memberIds, id) }); break;
      case "lists": this.emit({ listIds: this.toggleInArray(v.listIds, id) }); break;
      // Board is single-select on assigned-work (it feeds a single-id input to the work-done view),
      // so selecting replaces rather than accumulates; re-picking the active board clears it.
      case "boards": this.emit({ boardIds: v.boardIds.includes(id) ? [] : [id] }); break;
    }
  }

  clearDimension() {
    switch (this.view()) {
      case "labels": this.emit({ labelIds: [] }); break;
      case "members": this.emit({ memberIds: [] }); break;
      case "lists": this.emit({ listIds: [] }); break;
      case "boards": this.emit({ boardIds: [] }); break;
    }
  }

  // ---- Custom-field condition builder (moved out of both page components) -----------------

  readonly filteredFields = computed<AnyCustomField[]>(() => {
    const q = this.query().trim().toLowerCase();
    const fields = this.customFields();
    return q ? fields.filter((f) => f.name.toLowerCase().includes(q)) : fields;
  });

  readonly editingCondition = computed<CfFilterCondition | undefined>(() => {
    const i = this.editIndex();
    return i === null ? undefined : this.value().cfConditions[i];
  });

  operatorsFor(field: AnyCustomField): readonly { op: CfFilterOperator; label: string }[] {
    return OPERATORS_BY_TYPE[field.type as CustomFieldType];
  }

  operatorHasNoValue = operatorHasNoValue;
  operatorUsesIds = operatorUsesIds;

  cfIdRows(field: AnyCustomField): OptionRow[] {
    if (field.type === "user") {
      const me = this.currentUserId();
      return this.members().map((m) => ({ id: m.userId, label: m.userId === me ? "Me" : m.displayName, member: m }));
    }
    const options: WireCustomFieldOption[] = "options" in field ? field.options : [];
    return options.map((o) => ({ id: o.id, label: o.label, color: o.color }));
  }

  cfHasId(condition: CfFilterCondition, id: string): boolean {
    return (condition.ids ?? []).includes(id);
  }

  /** Add a condition on `fieldId` (seeded with its type's default operator) and edit it. */
  addField(fieldId: string) {
    const field = this.fieldById().get(fieldId);
    if (!field) return;
    const next = [...this.value().cfConditions, { fieldId, op: defaultOperatorFor(field.type as CustomFieldType) }];
    this.editIndex.set(next.length - 1);
    this.emit({ cfConditions: next });
    this.view.set("cf-edit");
  }

  editCondition(index: number) {
    this.editIndex.set(index);
    this.view.set("cf-edit");
  }

  removeCondition(index: number) {
    this.emit({ cfConditions: this.value().cfConditions.filter((_, idx) => idx !== index) });
  }

  private updateEditing(patch: Partial<CfFilterCondition>) {
    const i = this.editIndex();
    if (i === null) return;
    this.emit({
      cfConditions: this.value().cfConditions.map((c, idx) => (idx === i ? { ...c, ...patch } : c)),
    });
  }

  patchCf(patch: Partial<CfFilterCondition>) {
    this.updateEditing(patch);
  }

  /** Changing the operator drops operands that no longer apply so stale values don't filter. */
  changeOperator(op: CfFilterOperator) {
    this.updateEditing({ op, value: undefined, value2: undefined, ids: undefined });
  }

  toggleCfId(id: string) {
    const cond = this.editingCondition();
    if (!cond) return;
    this.updateEditing({ ids: this.toggleInArray(cond.ids ?? [], id) });
  }

  removeEditingCondition() {
    const i = this.editIndex();
    if (i === null) return;
    this.emit({ cfConditions: this.value().cfConditions.filter((_, idx) => idx !== i) });
    this.editIndex.set(null);
    this.view.set("cf-list");
  }

  // ---- Summaries --------------------------------------------------------------------------

  private memberName(id: string): string | undefined {
    if (id === this.currentUserId()) return "Me";
    return this.membersById().get(id)?.displayName;
  }

  /** "First +N" summary for a multi-select row, tolerating ids whose entity is gone. */
  private summary(ids: string[], nameOf: (id: string) => string | undefined): string {
    if (ids.length === 0) return "";
    const names = ids.map(nameOf).filter((n): n is string => !!n);
    if (names.length === 0) return `${ids.length}`;
    return names.length === 1 ? names[0]! : `${names[0]} +${names.length - 1}`;
  }

  cfSummary(cond: CfFilterCondition, field: AnyCustomField): string {
    const opLabel = this.operatorsFor(field).find((o) => o.op === cond.op)?.label ?? cond.op;
    if (operatorHasNoValue(cond.op)) return `${field.name} ${opLabel}`;
    if (operatorUsesIds(cond.op)) {
      const rows = this.cfIdRows(field);
      const names = (cond.ids ?? []).map((id) => rows.find((r) => r.id === id)?.label).filter((n): n is string => !!n);
      const summary = names.length === 0 ? "…" : names.length === 1 ? names[0]! : `${names[0]} +${names.length - 1}`;
      return `${field.name} ${opLabel} ${summary}`;
    }
    if (cond.op === "between") return `${field.name} ${cond.value || "…"}–${cond.value2 || "…"}`;
    return `${field.name} ${opLabel} ${cond.value || "…"}`;
  }
}
