import { cards } from "@kanera/shared/schema";

/**
 * The card columns that make up its time-in-progress clock (`InProgressClock`), for reading back
 * what `card_track_in_progress` wrote after a move so the response and `card:moved` report it whole.
 */
export const IN_PROGRESS_CLOCK_COLUMNS = {
  inProgressSince: cards.inProgressSince,
  inProgressSeconds: cards.inProgressSeconds,
};
