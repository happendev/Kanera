import type { OnInit } from "@angular/core";
import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from "@angular/core";
import { MAX_REMINDER_LEAD_DAYS } from "@kanera/shared/dto/reminder-limits";
import { DUE_DATE_SLOT_TIMES } from "@kanera/shared/due-date-slots";
import { NotificationsService } from "../../core/notifications/notifications.service";
import { ANCHORED_HOST_STYLES, type AnchoredPanelPlacement } from "../../shared/anchored-panel";
import { AnchoredPanelDirective } from "../../shared/anchored-panel.directive";
import { formatDate, formatDateTime, formatTime } from "../../shared/date-format";
import { addDays, localDateKey, parseDateInputValue } from "../../shared/day-key.util";
import { WEEKDAY_LABELS } from "../../shared/week-start";
import { buildMonthGrid, monthStart, shiftMonth } from "../../shared/month-grid";
import { ToastService } from "../../shared/toast.service";
import { TooltipDirective } from "../../shared/tooltip.directive";
import { parseTimeInput, sanitizeTimeInput, stepTime, TIME_INPUT_MAX_LENGTH } from "./reminder-time.util";

// Weekday headers in the interface language; the grid always starts on Monday (see
// shared/week-start.ts).
const WEEKDAY_NAMES = WEEKDAY_LABELS;

interface ReminderPreset {
  id: string;
  label: string;
  at: Date;
}

function atLocal(base: Date, dayOffset: number, hour: number, minute = 0): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + dayOffset);
  next.setHours(hour, minute, 0, 0);
  return next;
}

/** A local calendar day plus minutes since midnight, as one instant in the browser's zone. */
function instantFor(dayKey: string, minutes: number): Date | null {
  const day = parseDateInputValue(dayKey);
  if (!day) return null;
  day.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return day;
}

/**
 * "Remind me" for one card: a private, one-off notification at a chosen time.
 *
 * Quick picks save in one click. Anything else is a calendar day plus a typed or stepped time, on the
 * same calendar the due-date picker uses, so the two read as one family. Times are picked in the browser's
 * zone and sent as an absolute instant, so the reminder fires at the moment the user saw here even if
 * their profile zone differs.
 */
@Component({
  selector: "k-reminder-popover",
  standalone: true,
  imports: [TooltipDirective],
  hostDirectives: [AnchoredPanelDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- Contained: when opened from a card's context menu, keys typed here must not drive the menu's
         arrow-key and type-to-select navigation, and clicks must not reach the card tile underneath.
         Escape still bubbles so the panel's dismissal sees it. -->
    <div class="rp-panel" role="dialog" aria-label="Remind me" i18n-aria-label (keydown)="$event.key === 'Escape' || $event.stopPropagation()" (click)="$event.stopPropagation()">
      <div class="rp-head">
        <i class="ti ti-alarm"></i>
        <span class="rp-title" i18n="Popover heading for setting a personal card reminder">Remind me</span>
        @if (reminder(); as current) {
        <span class="rp-current" [class.is-fired]="current.firedAt">
          {{ currentLabel(current) }}
        </span>
        }
      </div>

      <div class="rp-body">
        <section class="rp-quick" aria-label="Quick picks" i18n-aria-label>
          @for (preset of presets(); track preset.id) {
          <button type="button" class="rp-preset" (click)="save(preset.at)" [disabled]="saving()">
            <span class="rp-preset-label">{{ preset.label }}</span>
            <span class="rp-preset-when">{{ format(preset.at) }}</span>
          </button>
          }
        </section>

        <section class="rp-calendar" aria-label="Pick a day" i18n-aria-label>
          <div class="rp-month">
            <button type="button" class="rp-icon-btn" (click)="previousMonth()" [disabled]="!canGoBack()" aria-label="Previous month" i18n-aria-label kTooltip="Previous month" i18n-kTooltip>
              <i class="ti ti-chevron-left"></i>
            </button>
            <div class="rp-month-label" aria-live="polite">{{ monthLabel() }}</div>
            <button type="button" class="rp-icon-btn" (click)="nextMonth()" [disabled]="!canGoForward()" aria-label="Next month" i18n-aria-label kTooltip="Next month" i18n-kTooltip>
              <i class="ti ti-chevron-right"></i>
            </button>
          </div>
          <div class="rp-weekdays" aria-hidden="true">
            @for (weekday of weekdays; track weekday) {
            <span>{{ weekday }}</span>
            }
          </div>
          <div class="rp-grid" role="grid" [attr.aria-label]="monthLabel()">
            @for (day of days(); track day.value) {
            <button
              type="button"
              class="rp-day"
              [class.is-muted]="!day.inMonth"
              [class.is-today]="day.isToday"
              [class.is-selected]="day.isSelected"
              [disabled]="day.isDisabled"
              [attr.aria-pressed]="day.isSelected"
              [attr.aria-label]="dayLabel(day.date)"
              (click)="selectDay(day.value)"
            >{{ day.day }}</button>
            }
          </div>
        </section>

        <section class="rp-time" aria-label="Pick a time" i18n-aria-label>
          <div class="rp-clock">
            <button type="button" class="rp-icon-btn" (click)="step(-1)" aria-label="15 minutes earlier" i18n-aria-label kTooltip="15 minutes earlier" i18n-kTooltip>
              <i class="ti ti-minus"></i>
            </button>
            <label class="rp-clock-field">
              <i class="ti ti-clock"></i>
              <input
                class="rp-clock-input"
                type="text"
                inputmode="text"
                [attr.maxlength]="timeMaxLength"
                autocomplete="off"
                spellcheck="false"
                aria-label="Time"
                i18n-aria-label="Label for the reminder time input"
                [value]="timeText()"
                (focus)="$any($event.target).select()"
                (input)="onTimeInput($any($event.target))"
                (blur)="commitTime()"
                (keydown.enter)="$event.preventDefault(); commitTime()"
                (keydown.arrowup)="$event.preventDefault(); step(1)"
                (keydown.arrowdown)="$event.preventDefault(); step(-1)"
              />
            </label>
            <button type="button" class="rp-icon-btn" (click)="step(1)" aria-label="15 minutes later" i18n-aria-label kTooltip="15 minutes later" i18n-kTooltip>
              <i class="ti ti-plus"></i>
            </button>
          </div>
        </section>
      </div>

      <div class="rp-foot">
        @if (reminder()) {
        <button type="button" class="rp-clear" (click)="clear()" [disabled]="saving()" i18n="Button: remove the card reminder">Clear</button>
        }
        <span class="rp-summary" [class.is-error]="draftProblem()" aria-live="polite">
          {{ draftProblem() ?? format(draftInstant()!) }}
        </span>
        <button type="button" class="rp-set" (click)="saveDraft()" [disabled]="saving() || !!draftProblem()" i18n>Set reminder</button>
      </div>
    </div>
  `,
  styles: [
    ANCHORED_HOST_STYLES,
    `
    .rp-panel {
      width: 100%;
      /* Only a short phone runs out of room below the button; the panel then scrolls inside, with the
         footer pinned so Set reminder stays in reach. */
      max-height: var(--ap-max-height, 600px);
      overflow-y: auto;
      overscroll-behavior: contain;
      box-sizing: border-box;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      background: var(--surface-overlay);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-lg);
      color: var(--text);
    }

    .rp-head {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border);

      > i { color: var(--accent); font-size: 16px; }
    }

    .rp-title {
      font-size: 13px;
      font-weight: 700;
    }

    .rp-current {
      margin-left: auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding: 2px 8px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--accent) 12%, transparent);
      color: var(--accent);
      font-size: 11px;
      font-weight: 600;

      &.is-fired {
        background: var(--surface-2);
        color: var(--text-muted);
      }
    }

    /* One column at every width, the same shape as the due-date picker: quick picks, calendar, time. */
    .rp-body {
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-width: 0;
    }

    .rp-quick {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px;
    }

    .rp-preset {
      height: auto;
      min-height: 40px;
      min-width: 0;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      justify-content: center;
      gap: 1px;
      padding: 5px 8px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--surface-2);
      color: var(--text);
      text-align: left;
      cursor: pointer;
      transition: background-color 0.12s, border-color 0.12s;

      &:hover:not(:disabled) {
        background: var(--surface-hover);
        border-color: var(--border-strong);
      }
    }

    .rp-preset-label {
      font-size: 12px;
      font-weight: 600;
      line-height: 1.2;
    }

    .rp-preset-when {
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-muted);
      font-size: 11px;
      font-weight: 500;
      line-height: 1.2;
    }

    .rp-month {
      display: grid;
      grid-template-columns: 30px 1fr 30px;
      align-items: center;
      gap: 6px;
      margin-bottom: 6px;
    }

    .rp-month-label {
      text-align: center;
      font-size: 13px;
      font-weight: 700;
    }

    .rp-icon-btn {
      width: 30px;
      height: 30px;
      flex: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
      transition: background-color 0.12s, color 0.12s, border-color 0.12s;

      &:hover:not(:disabled) {
        background: var(--surface-2);
        color: var(--text);
        border-color: var(--border);
      }

      &:disabled {
        cursor: not-allowed;
        opacity: 0.35;
      }

      i { font-size: 16px; }
    }

    .rp-weekdays,
    .rp-grid {
      display: grid;
      grid-template-columns: repeat(7, minmax(0, 1fr));
      gap: 3px;
    }

    .rp-weekdays span {
      height: 20px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--text-muted);
      font-size: 11px;
      font-weight: 700;
    }

    /* Fixed-height rather than square cells keep the stacked panel short enough to open below the header. */
    .rp-day {
      height: 34px;
      min-width: 0;
      padding: 0;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--text);
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
      transition: background-color 0.12s, color 0.12s, border-color 0.12s, box-shadow 0.12s;

      &:hover:not(:disabled) {
        background: var(--surface-2);
        border-color: var(--border);
      }

      &.is-muted { color: color-mix(in srgb, var(--text-muted) 55%, transparent); }

      &.is-today {
        border-color: color-mix(in srgb, var(--accent) 65%, var(--border));
        color: var(--accent);
      }

      &.is-selected,
      &.is-selected:hover:not(:disabled) {
        background: var(--accent);
        border-color: var(--accent);
        color: var(--accent-fg);
        box-shadow: 0 0 0 2px var(--ring);
      }

      &:disabled {
        cursor: not-allowed;
        opacity: 0.35;
      }
    }

    .rp-time {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .rp-clock {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .rp-clock-field {
      flex: 1;
      min-width: 0;
      height: 34px;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 0 10px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--surface-2);
      color: var(--text-muted);
      cursor: text;
      transition: border-color 0.15s, box-shadow 0.15s;

      &:focus-within {
        border-color: var(--accent);
        box-shadow: 0 0 0 3px var(--ring);
      }

      i { font-size: 15px; }
    }

    /* Compound selector: the global input reset would otherwise give this its own box and ring. */
    .rp-clock-field input.rp-clock-input {
      flex: 1;
      width: auto;
      min-width: 0;
      height: 100%;
      padding: 0;
      border: 0;
      background: transparent;
      box-shadow: none;
      color: var(--text);
      font: inherit;
      font-size: 14px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      text-align: center;
      outline: none;
    }

    .rp-foot {
      position: sticky;
      bottom: -10px;
      margin-bottom: -10px;
      padding-block: 8px 10px;
      display: flex;
      align-items: center;
      gap: 8px;
      border-top: 1px solid var(--border);
      background: var(--surface-overlay);
    }

    .rp-summary {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-muted);
      font-size: 12px;
      font-weight: 600;

      &.is-error { color: var(--danger); }
    }

    .rp-clear,
    .rp-set {
      flex: none;
      height: 30px;
      padding: 0 10px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
    }

    .rp-clear {
      border: 1px solid transparent;
      background: transparent;
      color: var(--text-muted);

      &:hover:not(:disabled) {
        background: color-mix(in srgb, var(--danger) 10%, transparent);
        color: var(--danger);
      }
    }

    .rp-set {
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

    @media (hover: none), (pointer: coarse), (any-pointer: coarse) {
      .rp-preset { min-height: 44px; }
      .rp-icon-btn,
      .rp-clock-field,
      .rp-clear,
      .rp-set { height: 44px; }
      .rp-icon-btn { width: 44px; }
    }
  `,
    /*
     * Anchored under the alarm button like every other popover, spanning the phone's width, with
     * touch-sized day rows.
     */
    `
    @media (max-width: 560px) {
      .rp-day { height: 40px; }
    }
  `,
  ],
})
export class ReminderPopoverComponent implements OnInit {
  private readonly panel = inject(AnchoredPanelDirective);
  private readonly notifications = inject(NotificationsService);
  private readonly toasts = inject(ToastService);

  readonly cardId = input.required<string>();
  /** Desktop placement override, e.g. beside a context-menu row instead of under a header button. */
  readonly panelPlacement = input<AnchoredPanelPlacement | null>(null);
  readonly dismissed = output<void>();

  readonly weekdays = WEEKDAY_NAMES;
  readonly saving = signal(false);
  readonly reminder = computed(() => this.notifications.reminderFor(this.cardId()));

  // Captured once per open: the presets and the calendar's floor describe "now" when the user
  // looked, not a moving target. Saving still re-checks against the real clock.
  private readonly openedAt = new Date();
  private readonly todayKey = localDateKey(this.openedAt);
  // The server's lead limit (eight weeks), so the calendar never offers a day the API would refuse.
  private readonly latest = new Date(this.openedAt.getTime() + MAX_REMINDER_LEAD_DAYS * 24 * 60 * 60 * 1000);
  private readonly lastDayKey = localDateKey(this.latest);

  readonly presets = computed<ReminderPreset[]>(() => {
    const now = this.openedAt;
    const morning = DUE_DATE_SLOT_TIMES.morning;
    const presets: ReminderPreset[] = [{ id: "hour", label: $localize`:Reminder quick pick:In 1 hour`, at: new Date(now.getTime() + 60 * 60 * 1000) }];
    // "Later today" only while there is a meaningful gap before the end of the working day.
    if (now.getHours() < 16) presets.push({ id: "later", label: $localize`:Reminder quick pick:Later today`, at: atLocal(now, 0, DUE_DATE_SLOT_TIMES.endOfWorkDay.hour) });
    presets.push({ id: "tomorrow", label: $localize`:Reminder quick pick:Tomorrow morning`, at: atLocal(now, 1, morning.hour, morning.minute) });
    const daysToMonday = ((8 - now.getDay()) % 7) || 7;
    presets.push({ id: "monday", label: $localize`:Reminder quick pick:Next Monday`, at: atLocal(now, daysToMonday, morning.hour, morning.minute) });
    // Keep the grid even when "Later today" has dropped out.
    if (presets.length < 4) presets.push({ id: "week", label: $localize`:Reminder quick pick - one week from now:Next week`, at: atLocal(now, 7, morning.hour, morning.minute) });
    return presets;
  });

  // Tomorrow morning, the most common choice, until ngOnInit can see whether a reminder is pending.
  private readonly defaultDraft = atLocal(this.openedAt, 1, DUE_DATE_SLOT_TIMES.morning.hour, DUE_DATE_SLOT_TIMES.morning.minute);
  readonly draftDay = signal(localDateKey(this.defaultDraft));
  readonly draftMinutes = signal(this.defaultDraft.getHours() * 60 + this.defaultDraft.getMinutes());
  readonly visibleMonth = signal(monthStart(this.defaultDraft));
  readonly timeText = signal(this.timeLabel(this.draftMinutes()));
  readonly timeMaxLength = TIME_INPUT_MAX_LENGTH;

  readonly monthLabel = computed(() => formatDate(this.visibleMonth(), "monthYear"));
  readonly canGoBack = computed(() => this.visibleMonth() > monthStart(this.openedAt));
  readonly canGoForward = computed(() => this.visibleMonth() < monthStart(this.latest));
  readonly days = computed(() => {
    const selected = this.draftDay();
    return buildMonthGrid(this.visibleMonth(), ({ value }) => ({
      isSelected: value === selected,
      isDisabled: value < this.todayKey || value > this.lastDayKey,
    }));
  });

  readonly draftInstant = computed(() => instantFor(this.draftDay(), this.draftMinutes()));
  /** Why the composed time cannot be saved, or null when it can. Shown in place of the summary. */
  readonly draftProblem = computed<string | null>(() => {
    const at = this.draftInstant();
    if (!at) return $localize`:Reminder validation hint:Pick a day`;
    if (at.getTime() <= this.openedAt.getTime()) return $localize`:Reminder validation hint:That time has already passed`;
    // Only reachable on the last allowed day, when the time is later than now.
    if (at.getTime() > this.latest.getTime()) return $localize`:Reminder validation hint:Reminders can be at most 8 weeks ahead`;
    return null;
  });

  constructor() {
    this.panel.configure({
      placement: () => {
        const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
        // Phones (the 560px breakpoint below) get the full width; the calendar is cramped at 308px.
        const phone = viewportWidth <= 560;
        return {
          align: "end",
          ...(phone ? {} : this.panelPlacement()),
          width: phone ? Math.round(viewportWidth - 16) : 308,
          margin: phone ? 8 : 12,
          maxHeight: phone ? 760 : 600,
          // On a desktop, reserve the whole natural height (like the due-date picker) so it never
          // scrolls; on a phone, prefer opening below the button and scroll if that is short.
          minHeight: phone ? 320 : 540,
          preserveMinHeight: !phone,
        };
      },
      onDismiss: () => this.dismissed.emit(),
    });
  }

  ngOnInit(): void {
    // Start from the pending reminder when there is one, so adjusting it is a nudge, not a re-entry.
    const current = this.reminder();
    if (!current || current.firedAt) return;
    const pending = new Date(current.remindAt);
    this.selectDay(localDateKey(pending));
    this.setMinutes(pending.getHours() * 60 + pending.getMinutes());
  }

  format(value: Date | string): string {
    const date = typeof value === "string" ? new Date(value) : value;
    const today = new Date();
    if (date.toDateString() === today.toDateString()) return $localize`:Reminder time today; time is e.g. 14.30:Today, ${formatTime(date)}:time:`;
    if (date.toDateString() === addDays(today, 1).toDateString()) return $localize`:Reminder time tomorrow; time is e.g. 14.30:Tomorrow, ${formatTime(date)}:time:`;
    return formatDateTime(date, "weekday");
  }

  currentLabel(current: { firedAt?: string | null; remindAt: string }): string {
    return current.firedAt
      ? $localize`:Status of a reminder that has already gone off; when is e.g. "Today, 09.00":Reminded ${this.format(current.firedAt)}:when:`
      : $localize`:Status of a pending reminder; when is e.g. "Tomorrow, 09.00":Set for ${this.format(current.remindAt)}:when:`;
  }

  timeLabel(minutes: number): string {
    return formatTime(new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60));
  }

  dayLabel(date: Date): string {
    return formatDate(date, "long");
  }

  previousMonth(): void {
    if (this.canGoBack()) this.visibleMonth.update((month) => shiftMonth(month, -1));
  }

  nextMonth(): void {
    if (this.canGoForward()) this.visibleMonth.update((month) => shiftMonth(month, 1));
  }

  selectDay(value: string): void {
    this.draftDay.set(value);
    const date = parseDateInputValue(value);
    if (date) this.visibleMonth.set(monthStart(date));
  }

  setMinutes(minutes: number): void {
    this.draftMinutes.set(minutes);
    this.timeText.set(this.timeLabel(minutes));
  }

  step(direction: 1 | -1): void {
    // Step from whatever is typed, so "9:10" then ArrowUp goes to 9:15 rather than from a stale draft.
    const typed = parseTimeInput(this.timeText());
    this.setMinutes(stepTime(typed ?? this.draftMinutes(), direction));
  }

  onTimeInput(field: HTMLInputElement): void {
    // Drop anything that cannot be part of a time as it is typed. The cleaned text is written back to
    // the element directly: when it equals the previous value the [value] binding would not re-render.
    const text = sanitizeTimeInput(field.value);
    if (field.value !== text) field.value = text;
    this.timeText.set(text);
    // A complete time updates the draft as it is typed so the summary follows along.
    const minutes = parseTimeInput(text);
    if (minutes !== null) this.draftMinutes.set(minutes);
  }

  commitTime(): void {
    // Leaving the field with something that is not a time puts the last good time back, rather than
    // leaving the picker in a state that cannot be saved.
    this.setMinutes(parseTimeInput(this.timeText()) ?? this.draftMinutes());
  }

  saveDraft(): void {
    this.commitTime();
    const at = this.draftInstant();
    if (at && !this.draftProblem()) void this.save(at);
  }

  async save(at: Date): Promise<void> {
    if (this.saving()) return;
    if (at.getTime() <= Date.now()) {
      this.toasts.error($localize`That time has already passed. Pick a later one.`);
      return;
    }
    this.saving.set(true);
    try {
      await this.notifications.setCardReminder(this.cardId(), at);
      this.toasts.success($localize`:Toast; when is e.g. "Tomorrow, 09.00":Reminder set for ${this.format(at)}:when:`, "alarm");
      this.dismissed.emit();
    } catch {
      this.toasts.error($localize`Couldn't set the reminder. Try again.`);
    } finally {
      this.saving.set(false);
    }
  }

  async clear(): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    try {
      await this.notifications.clearCardReminder(this.cardId());
      this.dismissed.emit();
    } catch {
      this.toasts.error($localize`Couldn't clear the reminder. Try again.`);
    } finally {
      this.saving.set(false);
    }
  }
}
