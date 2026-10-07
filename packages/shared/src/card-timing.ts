import { DEFAULT_INACTIVE_CARDS_DAYS } from "./lib/workspace-defaults.js";

export function isCardInactive(updatedAt: Date | string, now = Date.now(), inactiveCardsDays = DEFAULT_INACTIVE_CARDS_DAYS): boolean {
  const timestamp = updatedAt instanceof Date ? updatedAt.getTime() : new Date(updatedAt).getTime();
  return Number.isFinite(timestamp) && now - timestamp >= inactiveCardsDays * 24 * 60 * 60 * 1000;
}
