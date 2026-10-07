import { localDateKey } from "./day-key.util";
import { startOfWeek } from "./week-start";

/** The 6×7 cell grid a month calendar renders: every day of `month` plus the padding days around it. */
export interface MonthGridDay {
  date: Date;
  /** YYYY-MM-DD, the value the pickers store and compare. */
  value: string;
  day: number;
  inMonth: boolean;
  isToday: boolean;
}

export function monthStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/** The first of the month `offset` months away; the pickers step with ±1. */
export function shiftMonth(date: Date, offset: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + offset, 1);
}

/**
 * Builds the 42-day grid for `month`, starting on the viewer's week start, and lets the caller
 * decorate each cell with its own selection state. Six rows keep the popover height stable as the
 * month changes.
 */
export function buildMonthGrid<T>(month: Date, decorate: (day: MonthGridDay) => T): (MonthGridDay & T)[] {
  const todayValue = localDateKey(new Date());
  const first = startOfWeek(monthStart(month));
  return Array.from({ length: 42 }, (_, i) => {
    const date = new Date(first);
    date.setDate(first.getDate() + i);
    const value = localDateKey(date);
    const day: MonthGridDay = { date, value, day: date.getDate(), inMonth: date.getMonth() === month.getMonth(), isToday: value === todayValue };
    return { ...day, ...decorate(day) };
  });
}
