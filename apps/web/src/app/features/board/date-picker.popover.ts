import type {
  AfterViewInit,
  OnDestroy,
  OnInit} from "@angular/core";
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  inject,
  input,
  output,
  signal,
} from "@angular/core";
import { TooltipDirective } from "../../shared/tooltip.directive";
import { DUE_DATE_SLOT_OPTIONS, type DueDateSlot, type DueDateSlotSelection } from "./due-date.util";

type CalendarDay = {
  date: Date;
  value: string;
  day: number;
  inMonth: boolean;
  isToday: boolean;
  isSelected: boolean;
  isDisabled: boolean;
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

@Component({
  selector: "k-date-picker",
  standalone: true,
  imports: [TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="dp-panel" (click)="$event.stopPropagation()" (keydown.escape)="close.emit()">
      <div class="dp-head">
        <button type="button" class="dp-icon-btn" (click)="previousMonth()" aria-label="Previous month" kTooltip="Previous month">
          <i class="ti ti-chevron-left"></i>
        </button>
        <div class="dp-title" aria-live="polite">{{ monthLabel() }}</div>
        <button type="button" class="dp-icon-btn" (click)="nextMonth()" aria-label="Next month" kTooltip="Next month">
          <i class="ti ti-chevron-right"></i>
        </button>
      </div>

      @if (showShortcuts()) {
      <div class="dp-shortcuts">
        @for (sc of shortcuts; track sc.days) {
          <button type="button" (click)="selectRelative(sc.days)">
            <span class="dp-sc-label">{{ sc.label }}</span>
            <span class="dp-sc-date">{{ sc.dateLabel }}</span>
          </button>
        }
      </div>
      }

      @if (showSlots()) {
      <div class="dp-slots" aria-label="Due date time slot">
        @for (option of slotOptions; track option.value) {
          <button
            type="button"
            [class.is-selected]="draftSlot() === option.value"
            (click)="draftSlot.set(option.value)"
          >
            <span class="dp-slot-name">{{ slotDisplayLabel(option.value) }}</span>
            <span class="dp-slot-time">{{ slotTimeLabel(option.value) }}</span>
          </button>
        }
      </div>
      }

      <div class="dp-weekdays" aria-hidden="true">
        @for (weekday of weekdays; track weekday) {
          <span>{{ weekday }}</span>
        }
      </div>

      <div class="dp-grid" role="grid" [attr.aria-label]="monthLabel()">
        @for (day of days(); track day.value) {
          <button
            type="button"
            class="dp-day"
            [class.is-muted]="!day.inMonth"
            [class.is-today]="day.isToday"
            [class.is-selected]="day.isSelected"
            [class.is-disabled]="day.isDisabled"
            [disabled]="day.isDisabled"
            (click)="select(day.value, false)"
            [attr.aria-pressed]="day.isSelected"
            [attr.aria-label]="ariaLabel(day.date)"
          >
            {{ day.day }}
          </button>
        }
      </div>

      <div class="dp-foot">
        @if (value()) {
          <button type="button" class="dp-clear" (click)="clear.emit()">Clear</button>
        }
        <button type="button" class="dp-apply" [disabled]="!draftValue() || !isSelectable(draftValue())" (click)="apply()">Apply</button>
      </div>
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

    .dp-panel {
      width: 292px;
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

    .dp-head {
      display: grid;
      grid-template-columns: 30px 1fr 30px;
      align-items: center;
      gap: 6px;
    }

    .dp-title {
      text-align: center;
      font-size: 13px;
      font-weight: 700;
      color: var(--text);
    }

    .dp-icon-btn {
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

    .dp-shortcuts {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 6px;

      button {
        height: 40px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 1px;
        padding: 0 6px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--surface-2);
        color: var(--text);
        cursor: pointer;
        transition: background-color 0.12s, color 0.12s, border-color 0.12s;

        &:hover {
          background: var(--surface-hover);
          border-color: var(--border-strong);
        }
      }

      .dp-sc-label {
        font-size: 12px;
        font-weight: 600;
        line-height: 1.2;
      }

      .dp-sc-date {
        font-size: 11px;
        color: var(--text-muted);
        font-weight: 500;
        line-height: 1.2;
      }
    }

    .dp-slots {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 6px;

      button {
        min-height: 44px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 2px;
        padding: 6px 4px;
        border: 1px solid var(--border);
        border-radius: var(--radius);
        background: var(--surface-2);
        color: var(--text-muted);
        cursor: pointer;
        transition: background-color 0.12s, color 0.12s, border-color 0.12s;

        &:hover {
          background: var(--surface-hover);
          color: var(--text);
          border-color: var(--border-strong);
        }

        &.is-selected {
          background: color-mix(in srgb, var(--accent) 12%, var(--surface-2));
          border-color: var(--accent);
          color: var(--accent);

          .dp-slot-time {
            color: color-mix(in srgb, var(--accent) 70%, transparent);
          }
        }
      }
    }

    .dp-slot-name {
      font-size: 11px;
      font-weight: 600;
      text-align: center;
      line-height: 1.2;
    }

    .dp-slot-time {
      font-size: 10px;
      color: var(--text-muted);
      font-weight: 500;
      line-height: 1;
    }

    .dp-weekdays,
    .dp-grid {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      gap: 4px;
    }

    .dp-weekdays span {
      height: 22px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--text-muted);
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
    }

    .dp-day {
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

      &.is-selected {
        background: var(--accent);
        border-color: var(--accent);
        color: var(--accent-fg);
        box-shadow: 0 0 0 2px var(--ring);
      }

      &.is-disabled {
        cursor: not-allowed;
        opacity: 0.35;
      }

      &.is-disabled:hover {
        background: transparent;
        border-color: transparent;
      }
    }

    .dp-foot {
      padding-top: 6px;
      border-top: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .dp-clear,
    .dp-apply {
      height: 28px;
      padding: 0 8px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
    }

    .dp-clear {
      border: 1px solid transparent;
      background: transparent;
      color: var(--text-muted);

      &:hover {
        background: color-mix(in srgb, var(--danger) 10%, transparent);
        color: var(--danger);
      }
    }

    .dp-apply {
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
export class DatePickerPopover implements AfterViewInit, OnDestroy, OnInit {
  private readonly hostEl = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly value = input("");
  readonly slot = input<DueDateSlotSelection>("anyTime");
  // Date-only fields (e.g. date custom fields) reuse this calendar without time slots.
  readonly showSlots = input(true);
  readonly showShortcuts = input(true);
  readonly min = input<string | null>(null);
  readonly max = input<string | null>(null);
  readonly applyDate = output<{ value: string; slot: DueDateSlotSelection }>();
  readonly clear = output<void>();
  readonly close = output<void>();

  readonly weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  readonly slotOptions = DUE_DATE_SLOT_OPTIONS;
  readonly shortcuts = (() => {
    const today = startOfDay(new Date());
    const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const add = (days: number) => { const d = new Date(today); d.setDate(d.getDate() + days); return d; };
    return [
      { label: "Today", days: 0, dateLabel: fmt(add(0)) },
      { label: "Tomorrow", days: 1, dateLabel: fmt(add(1)) },
      { label: "Next week", days: 7, dateLabel: fmt(add(7)) },
    ];
  })();
  readonly visibleMonth = signal(this.initialVisibleMonth());
  readonly draftValue = signal(this.value());
  readonly draftSlot = signal<DueDateSlotSelection>(this.slot());

  private anchorEl: HTMLElement | null = null;
  private readonly reposition = () => this.position();

  readonly monthLabel = computed(() =>
    this.visibleMonth().toLocaleDateString(undefined, { month: "long", year: "numeric" }),
  );

  readonly days = computed<CalendarDay[]>(() => {
    const month = this.visibleMonth();
    const selected = this.draftValue();
    const todayValue = toDateInputValue(new Date());
    const min = this.min();
    const max = this.max();
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
        isSelected: value === selected,
        isDisabled: (min != null && value < min) || (max != null && value > max),
      };
    });
  });

  ngOnInit() {
    this.draftValue.set(this.value());
    this.draftSlot.set(this.slot());
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

  select(value: string, updateMonth = true) {
    if (!this.isSelectable(value)) return;
    this.draftValue.set(value);
    if (!updateMonth) return;

    const date = fromDateInputValue(value);
    if (date) this.visibleMonth.set(new Date(date.getFullYear(), date.getMonth(), 1));
  }

  selectRelative(days: number) {
    const date = startOfDay(new Date());
    date.setDate(date.getDate() + days);
    this.select(toDateInputValue(date));
  }

  apply() {
    const value = this.draftValue();
    if (!value || !this.isSelectable(value)) return;
    this.applyDate.emit({ value, slot: this.draftSlot() });
    this.close.emit();
  }

  ariaLabel(date: Date): string {
    return date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  }

  slotIcon(slot: DueDateSlot): string {
    const icons: Record<DueDateSlot, string> = {
      anyTime: "ti-calendar",
      morning: "ti-sunrise",
      afternoon: "ti-sun",
      endOfWorkDay: "ti-sunset",
    };
    return icons[slot];
  }

  slotDisplayLabel(slot: DueDateSlot): string {
    const labels: Record<DueDateSlot, string> = {
      anyTime: "Anytime",
      morning: "Morning",
      afternoon: "Afternoon",
      endOfWorkDay: "End of day",
    };
    return labels[slot];
  }

  slotTimeLabel(slot: DueDateSlot): string {
    const times: Record<DueDateSlot, string> = {
      anyTime: "",
      morning: "09:00",
      afternoon: "13:00",
      endOfWorkDay: "17:00",
    };
    return times[slot];
  }

  private initialVisibleMonth(): Date {
    const selected = fromDateInputValue(this.value());
    const base = selected ?? new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
  }

  isSelectable(value: string): boolean {
    const min = this.min();
    const max = this.max();
    return (min == null || value >= min) && (max == null || value <= max);
  }

  private position() {
    if (!this.anchorEl) return;
    const host = this.hostEl.nativeElement;
    const rect = this.anchorEl.getBoundingClientRect();
    const panelWidth = 292;
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
    this.close.emit();
  }
}
