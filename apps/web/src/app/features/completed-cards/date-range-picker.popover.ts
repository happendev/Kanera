import type { AfterViewInit, OnDestroy, OnInit } from "@angular/core";
import { ChangeDetectionStrategy, Component, ElementRef, HostListener, computed, inject, input, output, signal } from "@angular/core";
import { TooltipDirective } from "../../shared/tooltip.directive";

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

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function toDateInputValue(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function fromDateInputValue(value: string): Date | null {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function compareDateValue(a: string, b: string): number {
  return a.localeCompare(b);
}

@Component({
  selector: "k-date-range-picker",
  standalone: true,
  imports: [TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="drp-panel" (click)="$event.stopPropagation()" (keydown.escape)="dismiss.emit()">
      <div class="drp-head">
        <button type="button" class="drp-icon-btn" (click)="previousMonth()" aria-label="Previous month" kTooltip="Previous month">
          <i class="ti ti-chevron-left"></i>
        </button>
        <div class="drp-title" aria-live="polite">{{ monthLabel() }}</div>
        <button type="button" class="drp-icon-btn" (click)="nextMonth()" aria-label="Next month" kTooltip="Next month">
          <i class="ti ti-chevron-right"></i>
        </button>
      </div>

      <div class="drp-summary">
        <span>{{ draftLabel() }}</span>
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
        <button type="button" class="drp-clear" (click)="clear.emit()">Clear</button>
        }
        @if (!instant()) {
        <!-- Instant mode auto-applies as soon as a full range is chosen, so no Apply button. -->
        <button type="button" class="drp-apply" [disabled]="!draftFrom() && !draftTo()" (click)="apply()">Apply</button>
        }
      </div>
      }
    </div>
  `,
  styles: `
    :host {
      position: fixed;
      z-index: 300;
      visibility: hidden;
    }

    :host(.is-positioned) {
      visibility: visible;
    }

    .drp-panel {
      width: 312px;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      background: var(--surface);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-lg);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
      color: var(--text);
    }

    .drp-head {
      display: grid;
      grid-template-columns: 30px 1fr 30px;
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
      width: 30px;
      height: 30px;
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
      min-height: 32px;
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

      button {
        height: 32px;
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

    .drp-weekdays,
    .drp-grid {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      gap: 4px;
    }

    .drp-weekdays span {
      height: 22px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--text-muted);
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
    }

    .drp-day {
      aspect-ratio: 1;
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
})
export class DateRangePickerPopover implements AfterViewInit, OnDestroy, OnInit {
  private readonly hostEl = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly from = input("");
  readonly to = input("");
  /** Auto-apply as soon as a full range is chosen and hide the Apply button. */
  readonly instant = input(false);
  readonly applyRange = output<{ from: string; to: string }>();
  readonly clear = output<void>();
  readonly dismiss = output<void>();

  readonly weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  readonly shortcuts: RangeShortcut[] = [
    { label: "7 days", days: 7 },
    { label: "14 days", days: 14 },
    { label: "30 days", days: 30 },
    { label: "90 days", days: 90 },
  ];
  readonly visibleMonth = signal(this.initialVisibleMonth());
  readonly draftFrom = signal(this.from());
  readonly draftTo = signal(this.to());

  private anchorEl: HTMLElement | null = null;
  private readonly reposition = () => this.position();

  readonly monthLabel = computed(() =>
    this.visibleMonth().toLocaleDateString(undefined, { month: "long", year: "numeric" }),
  );
  readonly draftLabel = computed(() => this.rangeLabel(this.draftFrom(), this.draftTo()));

  readonly days = computed<CalendarDay[]>(() => {
    const month = this.visibleMonth();
    const from = this.draftFrom();
    const to = this.draftTo();
    const start = from && to && compareDateValue(from, to) > 0 ? to : from;
    const end = from && to && compareDateValue(from, to) > 0 ? from : to;
    const todayValue = toDateInputValue(new Date());
    const firstOfMonth = new Date(month.getFullYear(), month.getMonth(), 1);
    const first = new Date(firstOfMonth);
    first.setDate(first.getDate() - first.getDay());

    return Array.from({ length: 42 }, (_, i) => {
      const date = new Date(first);
      date.setDate(first.getDate() + i);
      const value = toDateInputValue(date);
      return {
        date,
        value,
        day: date.getDate(),
        inMonth: date.getMonth() === month.getMonth(),
        isToday: value === todayValue,
        isRangeStart: value === start,
        isRangeEnd: value === end,
        isInRange: !!start && !!end && compareDateValue(value, start) > 0 && compareDateValue(value, end) < 0,
      };
    });
  });

  ngOnInit() {
    this.draftFrom.set(this.from());
    this.draftTo.set(this.to());
    this.visibleMonth.set(this.initialVisibleMonth());
  }

  ngAfterViewInit() {
    this.anchorEl = this.hostEl.nativeElement.parentElement;
    this.position();
    window.addEventListener("resize", this.reposition);
    window.addEventListener("scroll", this.reposition, true);
  }

  ngOnDestroy() {
    window.removeEventListener("resize", this.reposition);
    window.removeEventListener("scroll", this.reposition, true);
  }

  previousMonth() {
    this.visibleMonth.update((date) => new Date(date.getFullYear(), date.getMonth() - 1, 1));
  }

  nextMonth() {
    this.visibleMonth.update((date) => new Date(date.getFullYear(), date.getMonth() + 1, 1));
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
    const end = startOfDay(new Date());
    const start = new Date(end);
    start.setDate(start.getDate() - days + 1);
    this.draftFrom.set(toDateInputValue(start));
    this.draftTo.set(toDateInputValue(end));
    this.visibleMonth.set(new Date(end.getFullYear(), end.getMonth(), 1));
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
    return date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  }

  private initialVisibleMonth(): Date {
    const selected = fromDateInputValue(this.to()) ?? fromDateInputValue(this.from());
    const base = selected ?? new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
  }

  private rangeLabel(from: string, to: string): string {
    if (from && to) return `${this.dateLabel(from)} - ${this.dateLabel(to)}`;
    if (from) return `From ${this.dateLabel(from)}`;
    if (to) return `Until ${this.dateLabel(to)}`;
    return "Select a start date, then an end date";
  }

  private dateLabel(value: string): string {
    const date = fromDateInputValue(value);
    return date ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date) : value;
  }

  private position() {
    if (!this.anchorEl) return;
    const host = this.hostEl.nativeElement;
    const rect = this.anchorEl.getBoundingClientRect();
    const panelWidth = 312;
    const margin = 8;
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    let left = rect.right - panelWidth;
    if (left < margin) left = margin;
    if (left + panelWidth > viewportW - margin) left = viewportW - panelWidth - margin;

    const panelHeight = host.offsetHeight || 390;
    let top = rect.bottom + 4;
    if (top + panelHeight > viewportH - margin) {
      const above = rect.top - 4 - panelHeight;
      if (above >= margin) top = above;
      else top = Math.max(margin, viewportH - panelHeight - margin);
    }

    host.style.top = `${top}px`;
    host.style.left = `${left}px`;
    host.classList.add("is-positioned");
  }

  @HostListener("document:click")
  onDocumentClick() {
    this.dismiss.emit();
  }
}
