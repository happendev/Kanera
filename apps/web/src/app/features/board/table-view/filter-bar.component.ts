import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from "@angular/core";
import type { OnDestroy } from "@angular/core";
import type { WorkDoneEventType } from "@kanera/shared/dto";
import type { WireCustomFieldOption } from "@kanera/shared/events";
import type { CustomFieldType } from "@kanera/shared/schema";
import type { AnchoredPanelPlacement } from "../../../shared/anchored-panel";
import { AnchoredPanelDirective } from "../../../shared/anchored-panel.directive";
import { AvatarComponent } from "../../../shared/avatar.component";
import { TooltipDirective } from "../../../shared/tooltip.directive";
import { DateRangePickerPopover } from "../../completed-cards/date-range-picker.popover";
import type { CfFilterCondition, CfFilterOperator, FilterValue } from "./filter.types";
import {
  OPERATORS_BY_TYPE,
  defaultOperatorFor,
  operatorHasNoValue,
  operatorUsesIds,
} from "./filter.types";
import { hasActiveFilter } from "./filter.util";
import type { AnyCustomField } from "./table-view.types";

const CF_VALUE_DEBOUNCE_MS = 250;

/**
 * Lightweight structural shapes so the bar stays decoupled from the wire/db row types.
 *
 * `group` is optional context (in practice the workspace name) used to bucket the options into
 * labelled sections. Pages that span one workspace leave it unset and get the flat list they had.
 */
export interface FilterLabel {
  id: string;
  name: string;
  color: string | null;
  group?: string | null;
}
export interface FilterMember {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  lastOnlineAt?: string | Date | null;
  group?: string | null;
}
export interface FilterList {
  id: string;
  name: string;
  icon: string | null;
  group?: string | null;
}
export interface FilterBoard {
  id: string;
  name: string;
  icon?: string | null;
  group?: string | null;
}

/** Which pane of the drill-down is showing. */
type PanelView = "menu" | "labels" | "members" | "lists" | "boards" | "work-done-type" | "cf-list" | "cf-edit" | "completed";

const WORK_DONE_TYPE_OPTIONS: { id: WorkDoneEventType | null; label: string; icon: string }[] = [
  { id: null, label: "All activity", icon: "history" },
  { id: "completed", label: "Completed", icon: "circle-check" },
  { id: "moved", label: "Moved", icon: "arrow-right" },
  { id: "created", label: "Created", icon: "plus" },
  { id: "checklistItemCompleted", label: "Checklist items", icon: "checkbox" },
];

/** A generic selectable row used by the label / member / list / board / id-set pickers. */
interface OptionRow {
  id: string;
  label: string;
  color?: string | null;
  icon?: string | null;
  member?: FilterMember;
  /** Section this row belongs to (workspace name), or null for the ungrouped section. */
  group?: string | null;
}

/** Rows bucketed under an optional heading, so same-named options stay tellable apart. */
interface OptionSection {
  key: string;
  label: string | null;
  rows: OptionRow[];
}

/** Bucket rows by their `group`, keeping the incoming order of both groups and rows. */
function groupRows(rows: OptionRow[]): OptionSection[] {
  const sections: OptionSection[] = [];
  for (const row of rows) {
    const label = row.group ?? null;
    const key = label ?? "";
    const section = sections.find((candidate) => candidate.key === key);
    if (section) section.rows.push(row);
    else sections.push({ key, label, rows: [row] });
  }
  return sections;
}

/**
 * Shared filter UI for board and global-work pages. Replaces the old single, fully
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
  imports: [AnchoredPanelDirective, AvatarComponent, DateRangePickerPopover, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="fb-wrap">
      <!-- The tooltip carries the active-condition count in words: the badge beside the icon says how
           many but never what, and in the compact form there is no label either. -->
      <button
        #fbBtn
        type="button"
        class="fb-btn"
        [class.active]="anyActive()"
        [class.is-compact]="compact()"
        [class.has-clear]="clearable()"
        [disabled]="disabled()"
        [kTooltip]="triggerLabel()"
        [attr.aria-label]="triggerLabel()"
        (click)="toggleOpen()"
      >
        <i class="ti ti-filter"></i>
        @if (!compact()) { <span>Filter</span> }
        @if (activeCount() > 0) { <span class="fb-badge">{{ activeCount() }}</span> }
      </button>
      <!-- "Clear all" also lives at the foot of the panel, but that is two clicks and a scroll past
           the thing you want gone. Same output either way, so the page still runs one reset. -->
      @if (clearable()) {
        <button
          type="button"
          class="fb-btn-clear"
          kTooltip="Clear filters"
          aria-label="Clear filters"
          (click)="clearAll.emit()"
        >
          <i class="ti ti-x"></i>
        </button>
      }

      @if (open()) {
        <div class="fb-panel" [class.fb-panel-flush]="view() === 'completed'" kAnchoredPanel [apAnchor]="fbBtn" [apPlacement]="panelPlacement" (apDismissed)="closePanel()">
          @switch (view()) {
            @case ('menu') {
              <div class="fb-menu">
                @if (showActivity() || showPrioritySet()) {
                  <div class="fb-section-label">Quick filters</div>
                }
                @if (showActivity()) {
                  <button type="button" class="fb-row" [class.active]="value().showUnreadOnly" (click)="toggleUnread()">
                    <i class="ti ti-bell fb-row-icon"></i><span class="fb-row-name">Unread</span>
                    @if (value().showUnreadOnly) { <i class="ti ti-check fb-row-check"></i> }
                  </button>
                  <button type="button" class="fb-row" [class.active]="value().showOverdueOnly" (click)="toggleOverdue()">
                    <i class="ti ti-alert-circle fb-row-icon"></i><span class="fb-row-name">Overdue</span>
                    @if (value().showOverdueOnly) { <i class="ti ti-check fb-row-check"></i> }
                  </button>
                  <button type="button" class="fb-row" [class.active]="value().showInactiveOnly" (click)="toggleInactive()">
                    <i class="ti ti-clock-pause fb-row-icon"></i>
                    <span class="fb-row-text">
                      <span class="fb-row-name">Inactive</span>
                      <small>No activity for 14 days</small>
                    </span>
                    @if (value().showInactiveOnly) { <i class="ti ti-check fb-row-check"></i> }
                  </button>
                }
                @if (showPrioritySet()) {
                  <button type="button" class="fb-row" [class.active]="value().showPrioritySetOnly" (click)="togglePrioritySet()">
                    <i class="ti ti-list-numbers fb-row-icon"></i>
                    <span class="fb-row-text">
                      <span class="fb-row-name">In Up next</span>
                      <small>Only cards in your Up next</small>
                    </span>
                    @if (value().showPrioritySetOnly) { <i class="ti ti-check fb-row-check"></i> }
                  </button>
                }
                <!-- Section headings turn the previously flat menu into scannable groups: what a
                     card *is* (labels/people/place/fields) versus its lifecycle state. -->
                @if (labels().length || (showMembers() && members().length) || (showBoards() && boards().length) || showWorkDoneType() || lists().length || customFields().length) {
                  <div class="fb-section-label">{{ showWorkDoneType() ? 'Work done' : 'Card details' }}</div>
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
                    <i class="ti ti-clipboard-list fb-row-icon"></i><span class="fb-row-name">Boards</span>
                    @if (boardSummary()) { <span class="fb-row-summary">{{ boardSummary() }}</span> }
                    <i class="ti ti-chevron-right fb-row-caret"></i>
                  </button>
                }
                @if (showWorkDoneType()) {
                  <button type="button" class="fb-row" [class.active]="workDoneEventType() !== null" (click)="go('work-done-type')">
                    <i class="ti ti-activity fb-row-icon"></i><span class="fb-row-name">Activity type</span>
                    @if (workDoneEventTypeLabel()) { <span class="fb-row-summary">{{ workDoneEventTypeLabel() }}</span> }
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
                @if (showCompleted() || showArchived() || showHideCompleted()) {
                  <div class="fb-section-label">Card status</div>
                }
                @if (showHideCompleted()) {
                  <button type="button" class="fb-row" [class.active]="hideCompleted()" (click)="hideCompletedChange.emit(!hideCompleted())">
                    <i class="ti ti-eye-off fb-row-icon"></i>
                    <span class="fb-row-text">
                      <span class="fb-row-name">Hide completed</span>
                      <small>Recently completed cards show by default</small>
                    </span>
                    @if (hideCompleted()) { <i class="ti ti-check fb-row-check"></i> }
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
                          <span class="fb-row-text">
                            <span class="fb-row-name">{{ cfSummary(cond, field) }}</span>
                            @if (fieldGroup(cond.fieldId); as group) { <small>{{ group }}</small> }
                          </span>
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
                @for (section of filteredFieldSections(); track section.key) {
                  @if (section.label) { <div class="fb-group">{{ section.label }}</div> }
                  @for (field of section.fields; track field.id) {
                    <button type="button" class="fb-row" [class.fb-indent]="!!section.label" (click)="addField(field.id)">
                      <i class="ti ti-{{ field.icon }} fb-row-icon"></i><span class="fb-row-name">{{ field.name }}</span>
                      <i class="ti ti-plus fb-row-caret"></i>
                    </button>
                  }
                } @empty {
                  <p class="fb-empty">No matching fields</p>
                }
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
                    <input class="fb-value" type="number" placeholder="Value" [value]="cond.value ?? ''" (input)="patchCfDebounced({ value: $any($event.target).value })" />
                  } @else if (field.type === 'date') {
                    @if (cond.op === 'between') {
                      <div class="fb-date-range">
                        <input class="fb-value" type="date" [value]="cond.value ?? ''" (input)="patchCfDebounced({ value: $any($event.target).value })" />
                        <span class="fb-date-sep">→</span>
                        <input class="fb-value" type="date" [value]="cond.value2 ?? ''" (input)="patchCfDebounced({ value2: $any($event.target).value })" />
                      </div>
                    } @else {
                      <input class="fb-value" type="date" [value]="cond.value ?? ''" (input)="patchCfDebounced({ value: $any($event.target).value })" />
                    }
                  } @else {
                    <input class="fb-value" type="text" placeholder="Value" [value]="cond.value ?? ''" (input)="patchCfDebounced({ value: $any($event.target).value })" />
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
                [inline]="true"
                [instant]="true"
                [from]="completedFrom()"
                [to]="completedTo()"
                (applyRange)="onCompletedApply($event)"
                (clear)="onCompletedClear()"
                (dismiss)="onCompletedDismiss()"
              />
            }

            @case ('work-done-type') {
              <div class="fb-head">
                <button type="button" class="fb-back" (click)="go('menu')" aria-label="Back"><i class="ti ti-chevron-left"></i></button>
                <span class="fb-head-title">Activity type</span>
                @if (workDoneEventType() !== null) {
                  <button type="button" class="fb-head-clear" (click)="selectWorkDoneEventType(null)">Clear</button>
                }
              </div>
              <div class="fb-list" role="radiogroup" aria-label="Activity type">
                @for (option of workDoneTypeOptions; track option.label) {
                  <button
                    type="button"
                    class="fb-row"
                    [class.active]="workDoneEventType() === option.id"
                    role="radio"
                    [attr.aria-checked]="workDoneEventType() === option.id"
                    (click)="selectWorkDoneEventType(option.id)"
                  >
                    <i [class]="'ti ti-' + option.icon + ' fb-row-icon'"></i>
                    <span class="fb-row-name">{{ option.label }}</span>
                    @if (workDoneEventType() === option.id) { <i class="ti ti-check fb-row-check"></i> }
                  </button>
                }
              </div>
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
                @for (section of filteredSections(); track section.key) {
                  @if (section.label) { <div class="fb-group">{{ section.label }}</div> }
                  @for (row of section.rows; track row.id) {
                    <button type="button" class="fb-row" [class.active]="rowSelected(row.id)" [class.fb-indent]="!!section.label" (click)="toggleRow(row.id)">
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
                } @empty {
                  <p class="fb-empty">Nothing to show</p>
                }
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

    /* Matches .k-toolbar-btn in shared/toolbar-styles.scss: this button sits in the same toolbar row
       as Group and Sort, and the pages hosting it used to nudge its height from outside
       (global-work.page.scss re-declared 36px through ::ng-deep). One size, declared here. */
    .fb-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      height: 36px;
      padding: 0 11px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--surface);
      color: var(--text);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: background-color 0.12s, color 0.12s, border-color 0.12s;
      &:hover:not(:disabled) { background: var(--surface-2); border-color: var(--border-strong); }
      &:disabled { cursor: not-allowed; opacity: 0.5; }
      /* The one canonical engaged treatment, same as .k-toolbar-btn.is-set. This single button used
         to have three of them depending on which slot it rendered in — including one that
         deliberately dropped the accent text — so "filters are hiding rows" looked different on the
         board, in the table, and on Global Work. */
      &.active {
        border-color: var(--accent);
        color: var(--accent);
        background: var(--accent-soft);
      }
      &.active:hover:not(:disabled) {
        border-color: var(--accent);
        background: color-mix(in srgb, var(--accent) 14%, transparent);
      }
      i { font-size: 15px; }
    }
    .fb-btn.is-compact { padding-inline: 8px; }

    /* Mirrors .k-toolbar-clear / .has-clear in shared/toolbar-styles.scss for the same reason the
       button above mirrors .k-toolbar-btn: this component is scoped, so it cannot pick up the
       page's copy of that partial. Only rendered while .active, so it always sits beside accent. */
    .fb-btn.has-clear { border-top-right-radius: 0; border-bottom-right-radius: 0; }

    .fb-btn-clear {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: none;
      /* Height comes from stretching to the flex line rather than a second copy of the button's
         36px, so the pair cannot drift apart. The height:auto is load-bearing — the global button
         reset pins 36px and an explicit height beats align-self:stretch. */
      align-self: stretch;
      height: auto;
      width: 26px;
      padding: 0;
      margin-left: -1px;
      color: var(--accent);
      background: var(--accent-soft);
      border: 1px solid var(--accent);
      border-radius: 0 var(--radius) var(--radius) 0;
      cursor: pointer;
      transition: background-color 0.12s, color 0.12s;
      i { font-size: 13px; }
      /* :not(:disabled) to outrank the reset's own button:hover:not(:disabled). */
      &:hover:not(:disabled) { color: var(--danger); background: color-mix(in srgb, var(--accent) 14%, transparent); }
      &:focus-visible { position: relative; z-index: 1; outline: 2px solid var(--border-strong); outline-offset: 1px; }
    }

    /* Wider than the pointer form: the clear is flush against the trigger that opens the panel, so a
       thumb-width miss does the opposite of what was intended. */
    @media (hover: none), (pointer: coarse), (any-pointer: coarse) {
      .fb-btn-clear { width: 36px; }
    }

    .fb-badge {
      min-width: 17px;
      height: 17px;
      padding: 0 4px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 999px;
      background: var(--accent, var(--border-strong));
      color: var(--accent-fg, var(--text));
      font-size: 10px;
      font-weight: 700;
      line-height: 1;
    }

    /* Placement comes from kAnchoredPanel; hidden until it has run so the panel never paints at
       (0, 0) for a frame. */
    .fb-panel {
      position: fixed;
      top: var(--ap-top, 0);
      left: var(--ap-left, 0);
      z-index: var(--z-panel, 300);
      width: var(--ap-width, min(320px, calc(100vw - 32px)));
      max-height: var(--ap-max-height, 460px);
      visibility: hidden;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 8px;
      background: var(--surface-overlay);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-lg);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
    }

    .fb-panel.is-positioned { visibility: visible; }

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

    /* Group heading inside an option list. Sticky so the workspace a row belongs to stays visible
       while scrolling — the whole reason these lists are grouped is that names repeat verbatim
       across workspaces ("Doing", "Priority"). */
    .fb-group {
      position: sticky;
      top: 0;
      z-index: 1;
      margin-top: 4px;
      padding: 5px 8px 3px;
      background: var(--surface-overlay);
      color: var(--text-muted);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;

      &:first-child { margin-top: 0; }
    }

    .fb-row-text {
      display: grid;
      flex: 1;
      min-width: 0;

      small {
        color: var(--text-muted);
        font-size: 11px;
        /* Explicit line-height: with overflow:hidden a tight line box clips the descenders of a
           workspace name ("Delivery"), which reads as a rendering fault rather than a hint. */
        line-height: 1.35;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
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

    /* Rows under a group heading are inset and joined by a hairline rail. Indentation is what makes
       the grouping legible: with a shared left edge the list still scans as flat, which defeats the
       point when the same list/field name repeats across workspaces. */
    .fb-row.fb-indent {
      position: relative;
      padding-left: 20px;

      &::before {
        content: "";
        position: absolute;
        top: -1px;
        bottom: -1px;
        left: 11px;
        width: 1px;
        background: var(--border);
      }
    }

    /* An active custom-field condition row: a main (edit) button plus a remove button. The row rests
       at --surface-2 (the active shade); each sub-button lightens to --surface-hover on hover to match
       the menu's other rows/icon buttons. overflow:hidden clips those hovers to the row's radius. */
    .fb-row-static { padding: 0; gap: 0; cursor: default; overflow: hidden; }
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
      transition: background-color 0.12s;
      &:hover { background: var(--surface-hover); }
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
      transition: background-color 0.12s, color 0.12s;
      &:hover { background: var(--surface-hover); color: var(--danger); }
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
    /* width: auto overrides the shared :host width var — inline, the calendar fills the panel. */
    .fb-drp { position: static; visibility: visible; display: block; width: auto; }
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

    /* Inside k-page-toolbar's collapsed panel the trigger stretches to a full row so it stacks with
       the other stacked controls; the panel still floats at viewport level so it does not get
       squeezed by that layout. 1024 is $bp-collapse in shared/_breakpoints.scss — the toolbar
       collapses at the same width precisely so the filter bar cannot go full-width mid-row while
       its neighbours stay auto-sized. */
    @media (max-width: 1024px) {
      :host { display: block; width: 100%; }
      .fb-wrap { width: 100%; }
      /* min-width:0 so the stacked row gives the clear its 26px instead of overflowing the panel. */
      .fb-btn { width: 100%; min-width: 0; justify-content: flex-start; }

      /* In the table's own toolbar the filter is one inline control among many wrapping buttons,
         not a stacked dropdown row, so keep it inline-sized instead of stretching full-width. */
      :host-context(.tv-filter-slot) { display: inline-flex; width: auto; }
      :host-context(.tv-filter-slot) .fb-btn { width: auto; justify-content: center; }
    }
  `,
})
export class FilterBarComponent implements OnDestroy {
  /**
   * Matches the placement this panel used to compute by hand. `margin: 16` is wider than the shared
   * default because the panel is tall and sits under a header that itself has 16px gutters.
   */
  readonly panelPlacement: AnchoredPanelPlacement = { align: "start", width: 320, gap: 6, margin: 16, maxHeight: 460 };

  readonly value = input.required<FilterValue>();
  readonly labels = input<FilterLabel[]>([]);
  readonly members = input<FilterMember[]>([]);
  readonly lists = input<FilterList[]>([]);
  readonly boards = input<FilterBoard[]>([]);
  readonly customFields = input<AnyCustomField[]>([]);
  /** Optional fieldId → section heading (the field's workspace), for multi-workspace pages. */
  readonly customFieldGroups = input<Record<string, string | null>>({});
  readonly workspaceId = input<string | null>(null);
  readonly currentUserId = input<string | null>(null);
  readonly disabled = input(false);
  readonly compact = input(false);

  readonly showMembers = input(false);
  readonly showBoards = input(false);
  /** History-only activity type dimension, hosted here so it uses the page's canonical filter UI. */
  readonly showWorkDoneType = input(false);
  readonly showActivity = input(true);
  /**
   * Opt in to the "Priority set" quick filter. Only pages whose rank pills show the *viewer's own*
   * "Up next" queue should enable it — the row promises "your queue", so Global Work (where the
   * pills can belong to a curated teammate) keeps it off.
   */
  readonly showPrioritySet = input(false);
  readonly showCompleted = input(false);
  readonly showArchived = input(false);
  /**
   * Opt in to the "Hide completed" toggle. Pages whose default view already includes recently
   * completed cards (the global work pages) need a way back to open-work-only; a board has no such
   * toggle, so this stays off unless a page asks for it.
   */
  readonly showHideCompleted = input(false);

  readonly completedFrom = input("");
  readonly completedTo = input("");
  readonly completedLabel = input("");
  readonly archived = input(false);
  readonly hideCompleted = input(false);
  readonly workDoneEventType = input<WorkDoneEventType | null>(null);

  readonly valueChange = output<FilterValue>();
  readonly completedChange = output<{ from: string; to: string }>();
  readonly completedClear = output<void>();
  readonly archivedChange = output<boolean>();
  readonly hideCompletedChange = output<boolean>();
  readonly workDoneEventTypeChange = output<WorkDoneEventType | null>();
  /** Fired by the in-panel "Clear all" so the parent runs one comprehensive reset + single reload. */
  readonly clearAll = output<void>();
  readonly opened = output<void>();

  readonly open = signal(false);
  readonly view = signal<PanelView>("menu");
  readonly query = signal("");
  /** Index into `value().cfConditions` of the condition being edited in the `cf-edit` view. */
  private readonly editIndex = signal<number | null>(null);
  private cfValueDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCfPatch: Partial<CfFilterCondition> | null = null;

  readonly anyActive = computed(() =>
    hasActiveFilter(this.value()) || this.completedActive() || this.archived() || this.hideCompleted()
    || (this.showWorkDoneType() && this.workDoneEventType() !== null)
  );
  readonly completedActive = computed(() => !!this.completedFrom() || !!this.completedTo());
  /**
   * Whether the inline × shows. Tied to the same condition as the engaged `.active` treatment, which
   * is what the shared `.k-toolbar-clear` in shared/toolbar-styles.scss assumes of every caller: the
   * clear inherits the accent fill and would read as a stray button on an unset control.
   */
  readonly clearable = computed(() => this.anyActive() && !this.disabled());

  /** Badge count: how many distinct filters are engaged (each CF condition counts once). */
  /**
   * Tooltip and accessible name for the trigger. Compact renders no text at all, so this is the only
   * thing that names the control there.
   */
  readonly triggerLabel = computed(() => {
    const count = this.activeCount();
    if (count === 0) return "Filter";
    return count === 1 ? "Filter · 1 active" : `Filter · ${count} active`;
  });

  readonly activeCount = computed(() => {
    const v = this.value();
    let n = v.labelIds.length + v.memberIds.length + v.listIds.length + v.boardIds.length + v.cfConditions.length;
    if (v.showUnreadOnly) n++;
    if (v.showOverdueOnly) n++;
    if (v.showInactiveOnly) n++;
    if (v.showPrioritySetOnly) n++;
    if (this.completedActive()) n++;
    if (this.archived()) n++;
    if (this.hideCompleted()) n++;
    if (this.showWorkDoneType() && this.workDoneEventType() !== null) n++;
    return n;
  });

  readonly workDoneTypeOptions = WORK_DONE_TYPE_OPTIONS;
  readonly workDoneEventTypeLabel = computed(() => {
    const selected = this.workDoneEventType();
    return selected === null ? "" : (WORK_DONE_TYPE_OPTIONS.find((option) => option.id === selected)?.label ?? "");
  });

  private readonly labelsById = computed(() => new Map(this.labels().map((l) => [l.id, l])));
  private readonly membersById = computed(() => new Map(this.members().map((m) => [m.userId, m])));
  private readonly listsById = computed(() => new Map(this.lists().map((l) => [l.id, l])));
  private readonly boardsById = computed(() => new Map(this.boards().map((b) => [b.id, b])));
  readonly fieldById = computed(() => new Map(this.customFields().map((f) => [f.id, f])));

  ngOnDestroy() {
    this.clearPendingCfPatch();
  }

  // Menu-row selection summaries, so active state is visible without drilling in.
  readonly labelSummary = computed(() => this.summary(this.value().labelIds, (id) => this.labelsById().get(id)?.name));
  readonly memberSummary = computed(() => this.summary(this.value().memberIds, (id) => this.memberName(id)));
  readonly listSummary = computed(() => this.summary(this.value().listIds, (id) => this.listsById().get(id)?.name));
  readonly boardSummary = computed(() => this.summary(this.value().boardIds, (id) => this.boardsById().get(id)?.name));

  // ---- Panel navigation -------------------------------------------------------------------

  /**
   * No `stopPropagation()`: the opening click has to reach PanelStackService's document listener so
   * whatever else is open gets dismissed. The panel this opens survives because
   * `AnchoredPanelDirective` registers in `ngAfterViewInit`, after this click has finished
   * propagating — and re-clicking still closes, because this runs at the target first.
   */
  toggleOpen() {
    if (this.disabled()) return;
    if (this.open()) {
      this.closePanel();
    } else {
      this.view.set("menu");
      this.query.set("");
      this.open.set(true);
      this.opened.emit();
    }
  }

  go(view: PanelView) {
    // Leaving the value editor without a usable operand drops the half-built condition so it
    // doesn't linger in the summary or get persisted (the matcher ignores it, but it shouldn't show).
    if (this.view() === "cf-edit" && view !== "cf-edit") this.pruneIncomplete();
    else this.flushPendingCfPatch();
    this.query.set("");
    this.view.set(view);
    this.open.set(true);
  }

  /**
   * Close the panel, first discarding any incomplete custom-field conditions. Public because
   * `kAnchoredPanel` calls it for every dismissal reason — outside click, Escape, and being
   * superseded by another panel opening — so the pruning happens on all three paths.
   */
  closePanel() {
    this.pruneIncomplete();
    this.open.set(false);
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
  toggleInactive() {
    this.emit({ showInactiveOnly: !this.value().showInactiveOnly });
  }
  togglePrioritySet() {
    this.emit({ showPrioritySetOnly: !this.value().showPrioritySetOnly });
  }
  toggleArchived() {
    this.archivedChange.emit(!this.archived());
  }
  selectWorkDoneEventType(type: WorkDoneEventType | null) {
    this.workDoneEventTypeChange.emit(type);
    this.go("menu");
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
    const original = this.value().cfConditions;
    const pending = this.pendingCfPatch;
    const pendingIndex = this.editIndex();
    const conds = pending && pendingIndex !== null
      ? original.map((c, idx) => (idx === pendingIndex ? { ...c, ...pending } : c))
      : original;
    this.clearPendingCfPatch();
    const kept = conds.filter((c) => this.conditionComplete(c));
    if (pending || kept.length !== original.length) {
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
      case "boards": return "Boards";
      default: return "";
    }
  });

  private readonly rows = computed<OptionRow[]>(() => {
    const me = this.currentUserId();
    switch (this.view()) {
      case "labels":
        return this.labels().map((l) => ({ id: l.id, label: l.name, color: l.color, group: l.group }));
      case "members":
        return this.members().map((m) => ({ id: m.userId, label: m.userId === me ? "Me" : m.displayName, member: m, group: m.group }));
      case "lists":
        return this.lists().map((l) => ({ id: l.id, label: l.name, icon: l.icon, group: l.group }));
      case "boards":
        return this.boards().map((b) => ({ id: b.id, label: b.name, icon: b.icon ?? null, group: b.group }));
      default:
        return [];
    }
  });

  readonly filteredRows = computed<OptionRow[]>(() => {
    const q = this.query().trim().toLowerCase();
    const rows = this.rows();
    return q ? rows.filter((r) => r.label.toLowerCase().includes(q) || (r.group ?? "").toLowerCase().includes(q)) : rows;
  });

  /** The visible rows bucketed under their `group` heading, preserving the incoming order. */
  readonly filteredSections = computed<OptionSection[]>(() => groupRows(this.filteredRows()));

  /** Same bucketing for the "add a field filter" list, keyed off the `customFieldGroups` input. */
  readonly filteredFieldSections = computed<{ key: string; label: string | null; fields: AnyCustomField[] }[]>(() => {
    const groups = this.customFieldGroups();
    const sections: { key: string; label: string | null; fields: AnyCustomField[] }[] = [];
    for (const field of this.filteredFields()) {
      const label = groups[field.id] ?? null;
      const key = label ?? "";
      const section = sections.find((candidate) => candidate.key === key);
      if (section) section.fields.push(field);
      else sections.push({ key, label, fields: [field] });
    }
    return sections;
  });

  fieldGroup(fieldId: string): string | null {
    return this.customFieldGroups()[fieldId] ?? null;
  }

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
      case "boards": this.emit({ boardIds: this.toggleInArray(v.boardIds, id) }); break;
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
    this.flushPendingCfPatch();
    this.editIndex.set(index);
    this.view.set("cf-edit");
  }

  removeCondition(index: number) {
    this.clearPendingCfPatch();
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
    this.clearPendingCfPatch();
    this.updateEditing(patch);
  }

  patchCfDebounced(patch: Partial<CfFilterCondition>) {
    this.pendingCfPatch = { ...(this.pendingCfPatch ?? {}), ...patch };
    if (this.cfValueDebounceTimer) clearTimeout(this.cfValueDebounceTimer);
    this.cfValueDebounceTimer = setTimeout(() => this.flushPendingCfPatch(), CF_VALUE_DEBOUNCE_MS);
  }

  /** Changing the operator drops operands that no longer apply so stale values don't filter. */
  changeOperator(op: CfFilterOperator) {
    this.clearPendingCfPatch();
    this.updateEditing({ op, value: undefined, value2: undefined, ids: undefined });
  }

  toggleCfId(id: string) {
    this.clearPendingCfPatch();
    const cond = this.editingCondition();
    if (!cond) return;
    this.updateEditing({ ids: this.toggleInArray(cond.ids ?? [], id) });
  }

  removeEditingCondition() {
    this.clearPendingCfPatch();
    const i = this.editIndex();
    if (i === null) return;
    this.emit({ cfConditions: this.value().cfConditions.filter((_, idx) => idx !== i) });
    this.editIndex.set(null);
    this.view.set("cf-list");
  }

  private flushPendingCfPatch() {
    const patch = this.pendingCfPatch;
    if (!patch) return;
    this.clearPendingCfPatch();
    this.updateEditing(patch);
  }

  private clearPendingCfPatch() {
    if (this.cfValueDebounceTimer) {
      clearTimeout(this.cfValueDebounceTimer);
      this.cfValueDebounceTimer = null;
    }
    this.pendingCfPatch = null;
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
