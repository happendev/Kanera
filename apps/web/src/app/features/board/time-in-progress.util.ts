import { workingMs } from "@kanera/shared/time-in-progress";
import { formatDate } from "../../shared/date-format";

type DateLike = Date | string | null | undefined;
type TimedCard = { inProgressSince?: DateLike; inProgressSeconds?: number | null; completedAt?: DateLike };
/** The card's workspace's IANA zone, whose working hours count (`WorkspaceRow.timeZone`). */
type TimeZone = string | null | undefined;

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function toMs(value: DateLike): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Wall-clock time in the card's running in-progress stint, or null when none is running. This is
 * how long the card has sat in progress (the "stuck" signal); tracked time is `timeInProgressMs`.
 *
 * The server ends a stint on completion (banking it into `inProgressSeconds` and clearing the start),
 * so a completed card with a start is only ever an optimistic completion whose echo has not landed:
 * freeze it at `completedAt` rather than letting it tick on, or report nothing when the chronology
 * is inverted.
 */
export function currentStintMs(card: TimedCard, now: number): number | null {
  const since = toMs(card.inProgressSince);
  if (since === null) return null;
  const completed = toMs(card.completedAt);
  if (completed !== null) return completed > since ? completed - since : null;
  // A live clock can start slightly "in the future" when this device's clock trails the server's.
  return Math.max(0, now - since);
}

/** Working time the running stint adds; 0 when none runs. */
function runningWorkingMs(card: TimedCard, now: number, timeZone: TimeZone): number {
  const since = toMs(card.inProgressSince);
  const stint = currentStintMs(card, now);
  if (since === null || stint === null) return 0;
  return workingMs(since, since + stint, timeZone);
}

/** Whether the card's clock is running now: open work in an In progress list. */
export function isInProgressRunning(card: TimedCard): boolean {
  return Boolean(card.inProgressSince) && !card.completedAt;
}

/**
 * Total tracked time in progress: every finished stint (banked by the server) plus the running one,
 * counting working hours only (09:00-17:00, Monday to Friday, in the workspace's zone; see
 * `@kanera/shared/time-in-progress`). This is the card's tracked time, so it keeps its value after
 * the card leaves progress or is completed.
 */
export function timeInProgressMs(card: TimedCard, now: number, timeZone: TimeZone): number {
  return Math.max(0, card.inProgressSeconds ?? 0) * SECOND + runningWorkingMs(card, now, timeZone);
}

/**
 * Whether a card has tracked time worth showing. A running clock always shows (it is live state,
 * even at 0). A stopped one shows from a minute up, so dragging a card through an In progress list
 * and straight back does not leave a permanent "<1m" on it.
 */
export function hasTimeInProgress(card: TimedCard): boolean {
  // A stopped card's total is exactly what the server banked, so no zone is needed to decide.
  return isInProgressRunning(card) || Math.max(0, card.inProgressSeconds ?? 0) * SECOND >= MINUTE;
}

/**
 * Compact chip text in hours, never days: tracked time counts at most 8 working hours a day, so
 * "3d" would read as 72 hours of work. "<1m", "45m", "5h", "96h", "1,240h".
 */
export function formatTimeInProgress(ms: number): string {
  if (ms < MINUTE) return "<1m";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  return `${HOURS_FORMAT.format(Math.floor(ms / HOUR))}h`;
}

const HOURS_FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

/**
 * Hours and minutes for totals, averages and card detail ("96h 20m", "45m"), where the chip's whole
 * hours would hide most of a short number.
 */
export function formatTrackedDuration(ms: number): string {
  if (ms < MINUTE) return ms > 0 ? "<1m" : "0m";
  const hours = Math.floor(ms / HOUR);
  const minutes = Math.floor((ms % HOUR) / MINUTE);
  if (!hours) return `${minutes}m`;
  return minutes ? `${HOURS_FORMAT.format(hours)}h ${minutes}m` : `${HOURS_FORMAT.format(hours)}h`;
}

const plural = (n: number, unit: string) => `${HOURS_FORMAT.format(n)} ${unit}${n === 1 ? "" : "s"}`;

/** Tracked time in words: "less than a minute", "45 minutes", "3 hours 20 minutes", "96 hours". */
function trackedWords(ms: number): string {
  if (ms < MINUTE) return "less than a minute";
  const hours = Math.floor(ms / HOUR);
  const minutes = Math.floor((ms % HOUR) / MINUTE);
  if (!hours) return plural(minutes, "minute");
  // Past ten hours the minutes are noise.
  return minutes && hours < 10 ? `${plural(hours, "hour")} ${plural(minutes, "minute")}` : plural(hours, "hour");
}

/** Wall-clock stint length in words: how long the card has sat in progress ("3 hours", "10 days"). */
function calendarWords(ms: number): string {
  if (ms < MINUTE) return "less than a minute";
  if (ms < HOUR) return plural(Math.floor(ms / MINUTE), "minute");
  if (ms < 48 * HOUR) return plural(Math.floor(ms / HOUR), "hour");
  if (ms < 14 * DAY) return plural(Math.floor(ms / DAY), "day");
  return plural(Math.floor(ms / (7 * DAY)), "week");
}

/**
 * Whether open work has been in its *current* stint past its workspace's alert
 * (`inProgressAlertDays`; 0 turns it off). The alert is about work that is stuck now, so it reads the
 * running stint, not the lifetime total: a card that took two weeks across three attempts is not
 * stuck. Stopped clocks never alert.
 */
export function isInProgressTooLong(card: TimedCard, now: number, alertDays: number): boolean {
  if (!isInProgressRunning(card) || alertDays <= 0) return false;
  const stint = currentStintMs(card, now);
  return stint !== null && stint >= alertDays * DAY;
}

/**
 * Tooltip / accessible text. Running: "In progress since 27 Sep (3 days) · 24 hours tracked", plus
 * "past the 7-day alert" once the stint crosses it; the calendar span and the tracked total differ
 * because tracking counts working hours only. Stopped: "96 hours tracked in progress".
 */
export function describeTimeInProgress(card: TimedCard, now: number, alertDays: number, timeZone: TimeZone): string | null {
  if (!hasTimeInProgress(card)) return null;
  const tracked = trackedWords(timeInProgressMs(card, now, timeZone));
  if (!isInProgressRunning(card)) return `${capitalise(tracked)} tracked in progress`;
  const stint = currentStintMs(card, now) ?? 0;
  const text = `In progress since ${formatDate(card.inProgressSince ?? null)} (${calendarWords(stint)}) · ${tracked} tracked`;
  return isInProgressTooLong(card, now, alertDays) ? `${text}, past the ${alertDays}-day alert` : text;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Everything a surface needs to render the time-in-progress chip, or null when there is nothing to show. */
export type TimeInProgressChip = {
  /** Total tracked time, in the compact chip form. */
  text: string;
  label: string;
  /** The clock is ticking: accent styling and the progress icon. Stopped totals render muted. */
  running: boolean;
  /** The running stint is past its workspace's alert: amber. */
  alert: boolean;
  ms: number;
};

export function timeInProgressChip(card: TimedCard, now: number, alertDays: number, timeZone: TimeZone): TimeInProgressChip | null {
  if (!hasTimeInProgress(card)) return null;
  const ms = timeInProgressMs(card, now, timeZone);
  return {
    text: formatTimeInProgress(ms),
    label: describeTimeInProgress(card, now, alertDays, timeZone)!,
    running: isInProgressRunning(card),
    alert: isInProgressTooLong(card, now, alertDays),
    ms,
  };
}

/** Whether two optional timestamps name the same instant, whatever their Date/string form. */
export function sameInstant(a: DateLike, b: DateLike): boolean {
  return toMs(a) === toMs(b);
}

/**
 * A persisted clock as the server reports it: a move response, a `card:moved` payload or a card row
 * (`InProgressClock`). Compact rows omit a null start and a zero total, so both are optional.
 */
export type ReportedInProgressClock = { inProgressSince?: Date | string | null; inProgressSeconds?: number | null };

export type InProgressClock = { inProgressSince: Date | string | null; inProgressSeconds: number };

/** Whether a reported clock matches what a card already holds. */
export function sameInProgressClock(card: ReportedInProgressClock, reported: ReportedInProgressClock): boolean {
  return sameInstant(card.inProgressSince, reported.inProgressSince) && (card.inProgressSeconds ?? 0) === (reported.inProgressSeconds ?? 0);
}

/** A reported clock with both fields present; a total the report omits keeps the card's value. */
export function resolveInProgressClock(card: ReportedInProgressClock, reported: ReportedInProgressClock): InProgressClock {
  return {
    inProgressSince: reported.inProgressSince ?? null,
    inProgressSeconds: reported.inProgressSeconds ?? card.inProgressSeconds ?? 0,
  };
}

/**
 * The client's mirror of the `card_track_in_progress` trigger, for optimistic moves only: the move
 * response and `card:moved` carry the persisted clock, which replaces this guess. Entering from
 * outside starts a stint, moving between two in-progress lists keeps it, leaving banks its working
 * time in the workspace's zone. A completed card never runs.
 */
export function nextInProgressClock(
  card: TimedCard,
  fromInProgress: boolean,
  toInProgress: boolean,
  at: Date,
  timeZone: TimeZone,
): InProgressClock {
  const banked = card.inProgressSeconds ?? 0;
  const running = isInProgressRunning(card);
  if (toInProgress && !card.completedAt) {
    if (fromInProgress && running) return { inProgressSince: card.inProgressSince!, inProgressSeconds: banked };
    return { inProgressSince: at, inProgressSeconds: banked };
  }
  if (!running) return { inProgressSince: null, inProgressSeconds: banked };
  return { inProgressSince: null, inProgressSeconds: banked + Math.floor(runningWorkingMs(card, at.getTime(), timeZone) / SECOND) };
}

/**
 * A clock in the compact row form Global Work keeps (`CompactCardSummary`): a null start and a zero
 * total are omitted rather than carried, so a patched row has the same shape as a freshly loaded one.
 */
export function compactInProgressClock(clock: InProgressClock) {
  return {
    inProgressSince: clock.inProgressSince ?? undefined,
    inProgressSeconds: clock.inProgressSeconds || undefined,
  };
}
