import type { OnInit } from "@angular/core";
import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from "@angular/core";
import { TooltipDirective } from "../../shared/tooltip.directive";
import { WEEKDAY_LABELS } from "../../shared/week-start";
import { ANCHORED_HOST_STYLES } from "../../shared/anchored-panel";
import { AnchoredPanelDirective } from "../../shared/anchored-panel.directive";
import { formatDate } from "../../shared/date-format";
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
          <i class="ti ti-chevron-left"></i>
        </button>
        <div class="drp-title" aria-live="polite">{{ monthLabel() }}</div>
        <button type="button" class="drp-icon-btn" (click)="nextMonth()" aria-label="Next month" i18n-aria-label kTooltip="Next month" i18n-kTooltip>
          <i class="ti ti-chevron-right"></i>
        </button>
      </div>

      <div class="drp-summary">
        <span>{{ draftLabel() }}</span>
      </div>

      <div class="drp-presets">
        @for (preset of presets; track preset.preset) {
        <button type="button" (click)="selectPreset(preset.preset)">
          {{ preset.label }}
        </button>
        }
      </div>

      <div class="drp-shortcuts">
        @for (shortcut of shortcuts; track shortcut.days) {
        <button type="button" (click)="selectLastDays(shortcut.days)">
          {{ shortcut.label }}
        </button>
        }
      </div>

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
          (click)="select(day.value)"
          [attr.aria-pressed]="day.isRangeStart || day.isRangeEnd || day.isInRange"
          [attr.aria-label]="ariaLabel(day.date)"
        >
          {{ day.day }}
        </button>
        }
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
      overflow-y: auto;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      background: var(--surface-overlay);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-lg);
      color: var(--text);
    }

    .drp-head {
      display: grid;
      grid-template-columns: 28px 1fr 28px;
      align-items: center;
      gap: 6px;
    }

    .drp-title {
      text-align: center;
      font-size: 13px;
      font-weight: 700;
      color: var(--text);
    }

    .drp-icon-btn {
      width: 28px;
      height: 28px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
      padding: 0;
      transition: background-color 0.12s, color 0.12s, border-color 0.12s;

      &:hover {
        background: var(--surface-2);
        color: var(--text);
        border-color: var(--border);
      }

      i {
        font-size: 16px;
      }
    }

    .drp-summary {
      min-height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0 10px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--surface-2);
      color: var(--text-muted);
      font-size: 12px;
      font-weight: 700;
      text-align: center;
    }

    .drp-shortcuts {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 6px;
    }

    /* Named periods wrap as content-width chips rather than a fixed grid: their labels vary a lot in
       length across languages ("Letztes Quartal" vs "先月") and must never truncate. */
    .drp-presets {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;

      button {
        flex: 1 1 auto;
        white-space: nowrap;
      }
    }

    .drp-shortcuts,
    .drp-presets {
      button {
        height: 28px;
        padding: 0 6px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--surface-2);
        color: var(--text);
        cursor: pointer;
        font-size: 12px;
        font-weight: 600;
        transition: background-color 0.12s, border-color 0.12s;

        &:hover {
          background: var(--surface-hover);
          border-color: var(--border-strong);
        }
      }
    }

    /* Touch: the range chips are the quickest path on a phone, so they get the app's 44px targets.
       The panel clamps to the viewport and scrolls if that pushes it past a short screen. */
    @media (hover: none), (pointer: coarse), (any-pointer: coarse) {
      .drp-shortcuts button,
      .drp-presets button {
        height: 44px;
      }
    }

    .drp-weekdays,
    .drp-grid {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      gap: 4px;
    }

    .drp-weekdays span {
      height: 20px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--text-muted);
      font-size: 11px;
      font-weight: 700;
    }

    .drp-day {
      height: 34px;
      min-width: 0;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--text);
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
      padding: 0;
      transition: background-color 0.12s, color 0.12s, border-color 0.12s, box-shadow 0.12s;

      &:hover {
        background: var(--surface-2);
        border-color: var(--border);
      }

      &.is-muted {
        color: color-mix(in srgb, var(--text-muted) 55%, transparent);
      }

      &.is-today {
        border-color: color-mix(in srgb, var(--accent) 65%, var(--border));
        color: var(--accent);
      }

      &.is-in-range {
        background: color-mix(in srgb, var(--accent) 12%, var(--surface-2));
        border-color: color-mix(in srgb, var(--accent) 18%, transparent);
      }

      &.is-range-start,
      &.is-range-end {
        background: var(--accent);
        border-color: var(--accent);
        color: var(--accent-fg);
        box-shadow: 0 0 0 2px var(--ring);
      }
    }

    .drp-foot {
      padding-top: 6px;
      border-top: 1px solid var(--border);
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
      font-size: 13px;
      font-weight: 600;
    }

    .drp-clear {
      border: 1px solid transparent;
      background: transparent;
      color: var(--text-muted);

      &:hover {
        background: color-mix(in srgb, var(--danger) 10%, transparent);
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
      placement: () => ({ align: "end", width: 288, maxHeight: 560 }),
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
    }));
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
