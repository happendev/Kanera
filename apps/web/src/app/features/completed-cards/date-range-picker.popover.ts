import type { OnInit } from "@angular/core";
import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from "@angular/core";
import { TooltipDirective } from "../../shared/tooltip.directive";
import { WEEKDAY_LABELS } from "../../shared/week-start";
import { ANCHORED_HOST_STYLES } from "../../shared/anchored-panel";
import { AnchoredPanelDirective } from "../../shared/anchored-panel.directive";
import { formatDate } from "../../shared/date-format";
import { hasCoarsePointer } from "../../core/browser/input-modality";
import { icu } from "../../core/i18n/icu";
import { parseDateInputValue } from "../../shared/day-key.util";
import { buildMonthGrid, monthStart, shiftMonth } from "../../shared/month-grid";
import type { DateRangeKeys, DateRangePreset } from "./date-range-presets";
import { resolveDateRangePreset, resolveLastDays } from "./date-range-presets";

type CalendarDay = {
  date: Date;
  value: string;
  day: number;
  inMonth: boolean;
  isToday: boolean;
  isRangeStart: boolean;
  isRangeEnd: boolean;
  isInRange: boolean;
  /** An endpoint of a multi-day range, so its inner corners square off into the in-range band. */
  joinsBand: boolean;
};

type RangeShortcut = {
  label: string;
  days: number;
};

type NamedPreset = {
  label: string;
  preset: DateRangePreset;
};

/** Shortcut button that selects the last N days. */
function lastDaysLabel(days: number): string {
  return icu($localize`:Date range shortcut button selecting the last N days:{days, plural, one {# day} other {# days}}`, { days });
}

function compareDateValue(a: string, b: string): number {
  return a.localeCompare(b);
}

@Component({
  selector: "k-date-range-picker",
  standalone: true,
  imports: [TooltipDirective],
  hostDirectives: [AnchoredPanelDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="drp-panel">
      <div class="drp-head">
        <button type="button" class="drp-icon-btn" (click)="previousMonth()" aria-label="Previous month" i18n-aria-label kTooltip="Previous month" i18n-kTooltip>
          <i aria-hidden="true" class="ti ti-chevron-left"></i>
        </button>
        <div class="drp-title" aria-live="polite">{{ monthLabel() }}</div>
        <button type="button" class="drp-icon-btn" (click)="nextMonth()" aria-label="Next month" i18n-aria-label kTooltip="Next month" i18n-kTooltip>
          <i aria-hidden="true" class="ti ti-chevron-right"></i>
        </button>
      </div>

      <div class="drp-summary">
        <span>{{ draftLabel() }}</span>
      </div>

      <div class="drp-presets">
        @for (preset of presets; track preset.preset) {
        <button type="button" class="k-tile" [class.is-selected]="activeShortcut() === preset.preset" (click)="selectPreset(preset.preset)">
          {{ preset.label }}
        </button>
        }
      </div>

      <div class="drp-shortcuts">
        @for (shortcut of shortcuts; track shortcut.days) {
        <button type="button" class="k-tile" [class.is-selected]="activeShortcut() === shortcut.days" (click)="selectLastDays(shortcut.days)">
          {{ shortcut.label }}
        </button>
        }
      </div>

      <!-- The only part that scrolls: when 44px touch rows outgrow the room below the trigger, the
           calendar gives way and the range chips above and Clear / Apply below stay in view. -->
      <div class="drp-body k-scroll-fade">
      <div class="drp-weekdays" aria-hidden="true">
        @for (weekday of weekdays; track weekday) {
        <span>{{ weekday }}</span>
        }
      </div>

      <div class="drp-grid" role="grid" [attr.aria-label]="monthLabel()">
        @for (day of days(); track day.value) {
        <button
          type="button"
          class="drp-day"
          [class.is-muted]="!day.inMonth"
          [class.is-today]="day.isToday"
          [class.is-in-range]="day.isInRange"
          [class.is-range-start]="day.isRangeStart"
          [class.is-range-end]="day.isRangeEnd"
          [class.joins-band]="day.joinsBand"
          (click)="select(day.value)"
          [attr.aria-pressed]="day.isRangeStart || day.isRangeEnd || day.isInRange"
          [attr.aria-label]="ariaLabel(day.date)"
        >
          {{ day.day }}
        </button>
        }
      </div>
      </div>

      @if (!instant() || draftFrom() || draftTo() || from() || to()) {
      <div class="drp-foot">
        @if (from() || to() || (instant() && (draftFrom() || draftTo()))) {
        <button type="button" class="drp-clear" (click)="clear.emit()" i18n="Button: clear the date range">Clear</button>
        }
        @if (!instant()) {
        <!-- Instant mode auto-applies as soon as a full range is chosen, so no Apply button. -->
        <button type="button" class="drp-apply" [disabled]="!draftFrom() && !draftTo()" (click)="apply()" i18n="Button: apply the date range">Apply</button>
        }
      </div>
      }
    </div>
  `,
  styles: [
    ANCHORED_HOST_STYLES,
    `
    .drp-panel {
      width: 100%;
      max-height: var(--ap-max-height, 560px);
      overflow: hidden;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      background: var(--surface-overlay);
      border: 1px solid var(--overlay-border);
      border-radius: var(--radius-md);
      box-shadow: var(--shadow-pop);
      color: var(--text);
    }

    .drp-panel > * {
      flex: none;
    }

    /* Ruled off from the chips above, so header, summary, chips and calendar do not run together. */
    .drp-panel > .drp-body {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      overscroll-behavior: contain;
      padding-top: 8px;
      border-top: 1px solid var(--overlay-separator);
    }

    .drp-head {
      display: grid;
      grid-template-columns: 28px 1fr 28px;
      align-items: center;
      gap: 6px;
    }

    .drp-title {
      text-align: center;
      font-size: var(--text-base);
      font-weight: 700;
      color: var(--text);
    }

    .drp-icon-btn {
      width: 28px;
      height: 28px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 0;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
      padding: 0;
      transition: background-color var(--motion-fast), color var(--motion-fast);

      &:hover:not(:disabled) {
        background: var(--surface-hover);
        color: var(--text);
      }

      i {
        font-size: var(--text-lg);
      }
    }

    /* Read-only: plain text, so it is not mistaken for a control beside the chips. */
    .drp-summary {
      min-height: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--text-muted);
      font-size: var(--text-sm);
      font-weight: 600;
      text-align: center;
    }

    /* A hairline between the named periods and the day counts: two kinds of shortcut, two groups. */
    .drp-shortcuts {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: var(--space-1);
      padding-top: 8px;
      border-top: 1px solid var(--overlay-separator);
    }

    /* Six tracks: three periods of two tracks over two of three, so both rows end flush with no
       empty cell. Labels vary a lot in length across languages ("Letztes Quartal" vs "先月") and
       must never truncate, so a long one wraps inside its chip instead. */
    .drp-presets {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: var(--space-1);

      button { grid-column: span 2; }
      button:nth-child(n + 4) { grid-column: span 3; }
    }

    /* Prefixed to outrank the shared chip rule below, which pins one 28px line. */
    .drp-panel .drp-presets button {
      height: auto;
      min-height: 28px;
      padding-block: 4px;
      line-height: 1.2;
      white-space: normal;
      text-wrap: balance;
    }

    /* Outlined, unfilled option tiles (.k-tile in styles.scss), so nine of them do not outweigh the
       calendar; the chip matching the current range takes the tile's selection recipe. */
    .drp-shortcuts,
    .drp-presets {
      button {
        height: 28px;
        padding: 0 6px;
        font-size: var(--text-sm);
        font-weight: 500;

        &.is-selected { font-weight: 600; }
      }
    }

    .drp-weekdays,
    .drp-grid {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
    }

    .drp-weekdays span {
      height: 20px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--text-muted);
      font-size: var(--text-xs);
      font-weight: 700;
    }

    /* No column gap: the in-range days join into one continuous band. */
    .drp-grid {
      row-gap: 2px;
    }

    .drp-day {
      height: 34px;
      min-width: 0;
      border: 0;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--text);
      cursor: pointer;
      font-size: var(--text-base);
      font-weight: 600;
      padding: 0;
      transition: background-color var(--motion-fast), color var(--motion-fast);

      &:hover:not(:disabled) {
        background: var(--surface-hover);
        color: var(--text);
      }

      /* Days of the neighbouring months are selectable, so they are a tier quieter, not faded out. */
      &.is-muted {
        color: var(--text-muted);
      }

      /* Today is the one cell with an outline, so it still reads inside the band. */
      &.is-today {
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 65%, var(--overlay-border));
        color: var(--accent);
      }

      /* Square inside the band; rounded where the band meets a week edge. Full ink, a neighbouring
         month's day included: inside the range it is chosen, not secondary. The overlay selection
         token is the stronger wash that still reads on the dark overlay. */
      &.is-in-range {
        border-radius: 0;
        background: var(--overlay-selected, var(--accent-soft));
      }

      &.is-in-range:not(.is-today) {
        color: var(--text);
      }

      &.is-in-range:nth-child(7n + 1) {
        border-start-start-radius: var(--radius-sm);
        border-end-start-radius: var(--radius-sm);
      }

      &.is-in-range:nth-child(7n) {
        border-start-end-radius: var(--radius-sm);
        border-end-end-radius: var(--radius-sm);
      }

      &.is-in-range:hover:not(:disabled) {
        background: var(--surface-hover);
      }

      /* Only the endpoints are filled. No --ring halo: in dark it muddied the fill's edge. */
      &.is-range-start,
      &.is-range-start:hover:not(:disabled),
      &.is-range-end,
      &.is-range-end:hover:not(:disabled) {
        background: var(--accent);
        color: var(--accent-fg);
        box-shadow: none;
      }

      &.is-range-start.joins-band:not(:nth-child(7n)) {
        border-start-end-radius: 0;
        border-end-end-radius: 0;
      }

      &.is-range-end.joins-band:not(:nth-child(7n + 1)) {
        border-start-start-radius: 0;
        border-end-start-radius: 0;
      }
    }

    .drp-foot {
      padding-top: 6px;
      border-top: 1px solid var(--overlay-separator);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .drp-clear,
    .drp-apply {
      height: 28px;
      padding: 0 8px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      font-size: var(--text-base);
      font-weight: 600;
    }

    .drp-clear {
      border: 1px solid transparent;
      background: transparent;
      color: var(--text-muted);

      &:hover:not(:disabled) {
        background: var(--danger-soft);
        color: var(--danger);
      }
    }

    .drp-apply {
      margin-left: auto;
      border: 1px solid var(--accent);
      background: var(--accent);
      color: var(--accent-fg);

      &:hover:not(:disabled) {
        background: var(--accent-hover);
        border-color: var(--accent-hover);
      }

      &:disabled {
        cursor: not-allowed;
        opacity: 0.45;
      }
    }

    /* Touch: every target takes the 44px floor. The range chips are the quickest path on a phone;
       the panel widens (see the placement) so seven 44px days fit a row. The chrome between the
       targets tightens instead, so all six weeks and the footer fit under the work-done toolbar on
       a 390x844 phone (about 578px of 583px); a shorter screen scrolls the calendar body. */
    @media (hover: none), (pointer: coarse), (any-pointer: coarse) {
      .drp-panel {
        padding: 8px;
        gap: 4px;
      }

      .drp-summary {
        min-height: 16px;
      }

      .drp-shortcuts,
      .drp-panel > .drp-body,
      .drp-foot {
        padding-top: 4px;
      }

      .drp-weekdays span {
        height: 16px;
      }

      .drp-grid {
        row-gap: 1px;
      }

      .drp-head {
        grid-template-columns: 44px 1fr 44px;
      }

      .drp-panel .drp-presets button {
        min-height: 44px;
      }

      .drp-icon-btn,
      .drp-shortcuts button,
      .drp-day,
      .drp-clear,
      .drp-apply {
        height: 44px;
      }

      .drp-icon-btn {
        width: 44px;
      }

      .drp-clear,
      .drp-apply {
        padding-inline: 14px;
      }
    }
  `,
  ],
})
export class DateRangePickerPopover implements OnInit {
  private readonly panel = inject(AnchoredPanelDirective);

  readonly from = input("");
  readonly to = input("");
  /** Auto-apply as soon as a full range is chosen and hide the Apply button. */
  readonly instant = input(false);
  /**
   * Rendered in flow inside another panel (the filter bar's Completed step) rather than as a floating
   * popover. Placement, viewport listeners and stack registration are all skipped — the last matters,
   * or the embedded calendar would register as a sibling layer and swallow the Escape that should
   * close the whole filter panel.
   */
  readonly inline = input(false);
  readonly applyRange = output<{ from: string; to: string }>();
  readonly clear = output<void>();
  readonly dismiss = output<void>();

  readonly weekdays = WEEKDAY_LABELS;
  readonly shortcuts: RangeShortcut[] = [
    { label: lastDaysLabel(7), days: 7 },
    { label: lastDaysLabel(14), days: 14 },
    { label: lastDaysLabel(30), days: 30 },
    { label: lastDaysLabel(90), days: 90 },
  ];
  readonly presets: NamedPreset[] = [
    { label: $localize`:Date range preset button selecting the current week up to today:This week`, preset: "thisWeek" },
    { label: $localize`:Date range preset button selecting the whole previous week:Last week`, preset: "lastWeek" },
    { label: $localize`:Date range preset button selecting the current month up to today:This month`, preset: "thisMonth" },
    { label: $localize`:Date range preset button selecting the whole previous calendar month:Last month`, preset: "lastMonth" },
    {
      label: $localize`:Date range preset button selecting the whole previous calendar quarter:Last quarter`,
      preset: "lastQuarter",
    },
  ];
  readonly visibleMonth = signal(this.initialVisibleMonth());
  readonly draftFrom = signal(this.from());
  readonly draftTo = signal(this.to());

  constructor() {
    this.panel.configure({
      // Sized so the whole picker — header, summary, period presets, shortcuts, six week rows and the
      // Apply footer — fits without an inner scrollbar. The panel is ~490px tall at this width (more
      // when long translations wrap the presets onto a third row); anything lower hid the footer
      // behind a scroll the user had to discover. Placement still clamps it to short viewports.
      // Touch widens the panel so seven 44px day targets fit a row (still clamped to the viewport),
      // and allows the taller panel those targets make.
      placement: () => (hasCoarsePointer() ? { align: "end", width: 340, maxHeight: 700 } : { align: "end", width: 288, maxHeight: 560 }),
      inline: () => this.inline(),
      onDismiss: () => this.dismiss.emit(),
    });
  }

  readonly monthLabel = computed(() =>
    formatDate(this.visibleMonth(), "monthYear"),
  );
  readonly draftLabel = computed(() => this.rangeLabel(this.draftFrom(), this.draftTo()));

  readonly days = computed<CalendarDay[]>(() => {
    const from = this.draftFrom();
    const to = this.draftTo();
    const start = from && to && compareDateValue(from, to) > 0 ? to : from;
    const end = from && to && compareDateValue(from, to) > 0 ? from : to;
    return buildMonthGrid(this.visibleMonth(), ({ value }) => ({
      isRangeStart: value === start,
      isRangeEnd: value === end,
      isInRange: !!start && !!end && compareDateValue(value, start) > 0 && compareDateValue(value, end) < 0,
      joinsBand: !!start && !!end && start !== end && (value === start || value === end),
    }));
  });

  /**
   * The preset or "last N days" shortcut whose range the draft currently equals, so the chip that
   * produced it (or a calendar pick that happens to match one) reads as selected. Named periods win
   * a tie with a day count ("This month" on the 7th is also "7 days"), being the more specific name.
   */
  readonly activeShortcut = computed<DateRangePreset | number | null>(() => {
    const from = this.draftFrom();
    const to = this.draftTo();
    if (!from || !to) return null;
    const today = new Date();
    const matches = (range: DateRangeKeys) => range.from === from && range.to === to;
    return this.presets.find((p) => matches(resolveDateRangePreset(p.preset, today)))?.preset
      ?? this.shortcuts.find((s) => matches(resolveLastDays(s.days, today)))?.days
      ?? null;
  });

  ngOnInit() {
    this.draftFrom.set(this.from());
    this.draftTo.set(this.to());
    this.visibleMonth.set(this.initialVisibleMonth());
  }

  previousMonth() {
    this.visibleMonth.update((date) => shiftMonth(date, -1));
  }

  nextMonth() {
    this.visibleMonth.update((date) => shiftMonth(date, 1));
  }

  select(value: string) {
    const from = this.draftFrom();
    const to = this.draftTo();
    if (!from || to) {
      // Starting a new range: first click sets the start and clears any previous end.
      this.draftFrom.set(value);
      this.draftTo.set("");
      return;
    }

    if (compareDateValue(value, from) < 0) {
      this.draftFrom.set(value);
      this.draftTo.set(from);
    } else {
      this.draftTo.set(value);
    }
    this.emitIfInstant();
  }

  selectLastDays(days: number) {
    this.selectRange(resolveLastDays(days, new Date()));
  }

  selectPreset(preset: DateRangePreset) {
    this.selectRange(resolveDateRangePreset(preset, new Date()));
  }

  /** Applies a shortcut's range and shows the month it ends in, so the selection is visible. */
  private selectRange(range: DateRangeKeys) {
    this.draftFrom.set(range.from);
    this.draftTo.set(range.to);
    const end = parseDateInputValue(range.to);
    if (end) this.visibleMonth.set(monthStart(end));
    this.emitIfInstant();
  }

  /** In instant mode, commit the range the moment it's complete (no Apply button). */
  private emitIfInstant() {
    if (this.instant() && this.draftFrom() && this.draftTo()) {
      this.applyRange.emit({ from: this.draftFrom(), to: this.draftTo() });
    }
  }

  apply() {
    this.applyRange.emit({ from: this.draftFrom(), to: this.draftTo() });
    this.dismiss.emit();
  }

  ariaLabel(date: Date): string {
    return formatDate(date, "long");
  }

  private initialVisibleMonth(): Date {
    const selected = parseDateInputValue(this.to()) ?? parseDateInputValue(this.from());
    const base = selected ?? new Date();
    return monthStart(base);
  }

  private rangeLabel(from: string, to: string): string {
    if (from && to) return $localize`:Selected date range:${this.dateLabel(from)}:startDate: - ${this.dateLabel(to)}:endDate:`;
    if (from) return $localize`:Date range with only a start date:From ${this.dateLabel(from)}:startDate:`;
    if (to) return $localize`:Date range with only an end date:Until ${this.dateLabel(to)}:endDate:`;
    return $localize`:Date range picker hint:Select a start date, then an end date`;
  }

  private dateLabel(value: string): string {
    const date = parseDateInputValue(value);
    return date ? formatDate(date, "medium") : value;
  }

}
