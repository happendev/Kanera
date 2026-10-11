/** Minutes in a day; reminder times are held as minutes since local midnight. */
const DAY_MINUTES = 24 * 60;

/** Longest thing worth typing into the time box: "12:30 pm". */
export const TIME_INPUT_MAX_LENGTH = 8;

/**
 * Strips what can never be part of a time ("-110", letters other than am/pm) as it is typed, so the
 * box only ever holds digits, ":" or ".", a space, and the a/p/m of a 12-hour time.
 */
export function sanitizeTimeInput(text: string): string {
  return text.replace(/[^0-9:. apmAPM]/g, "").slice(0, TIME_INPUT_MAX_LENGTH);
}

/**
 * Parses what people actually type into a time box: "14:30", "1430", "9", "9am", "2:30 pm", "2.30p".
 * Returns minutes since midnight, or null when the text is not a real time.
 * A bare "12am"/"12pm" follows the 12-hour clock (midnight/noon), not 24-hour 12:00.
 */
export function parseTimeInput(text: string): number | null {
  const value = text.trim().toLowerCase().replace(/\s+/g, "");
  if (!value) return null;
  const match = /^(\d{1,2})(?:[:.]?(\d{2}))?(a|am|p|pm)?$/.exec(value);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const meridiem = match[3]?.[0];
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem === "p" ? 12 : 0);
  } else if (hour > 23) {
    return null;
  }
  return hour * 60 + minute;
}

/**
 * Steps a time to the next (or previous) multiple of `step` minutes, wrapping around midnight, so
 * 09:07 steps up to 09:15 rather than 09:22 and the field settles onto round times.
 */
export function stepTime(minutes: number, direction: 1 | -1, step = 15): number {
  const snapped = direction > 0 ? Math.floor(minutes / step) * step + step : Math.ceil(minutes / step) * step - step;
  return ((snapped % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
}
