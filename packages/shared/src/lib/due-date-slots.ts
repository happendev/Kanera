/**
 * Due-date slots and the wall-clock cut-off each one represents.
 *
 * Dependency-free on purpose, mirroring `lib/colors.ts`: the schema layer, the Zod DTOs, the
 * web bundle and the MCP server all need these values, and only the DTO layer may pull in zod.
 *
 * These cut-offs are the definition of "overdue". They are consumed by the API's TypeScript
 * check (`lib/due-date.ts`), three SQL `case` expressions (`lib/card-due-sql.ts`), the overdue
 * email copy, the web badge, and the MCP tool schema. Restating them anywhere else lets the
 * server and the client disagree about whether the same card is late.
 */
export const CARD_DUE_DATE_SLOTS = ["anyTime", "morning", "afternoon", "endOfWorkDay"] as const;
export type CardDueDateSlot = (typeof CARD_DUE_DATE_SLOTS)[number];

/**
 * The local time at which a card in each slot becomes overdue.
 *
 * `anyTime` is 21:00 rather than midnight so a card with no explicit slot stays actionable for
 * essentially the whole of its due date without rolling into the next one.
 */
export const DUE_DATE_SLOT_TIMES: Record<CardDueDateSlot, { hour: number; minute: number }> = {
  anyTime: { hour: 21, minute: 0 },
  morning: { hour: 9, minute: 0 },
  afternoon: { hour: 13, minute: 0 },
  endOfWorkDay: { hour: 17, minute: 0 },
};

/**
 * Sort order for agenda-style views: earliest cut-off first, with the all-day slot last.
 *
 * `anyTime` sorts last despite having the latest cut-off because a card with no chosen slot
 * reads as "sometime today", which belongs after the cards with a committed time.
 */
export const DUE_DATE_SLOT_RANK: Record<CardDueDateSlot, number> = {
  morning: 0,
  afternoon: 1,
  endOfWorkDay: 2,
  anyTime: 3,
};

/** Zero-padded `HH:MM` for a slot, e.g. `"09:00"`. Empty for `anyTime`, which shows no time. */
export function dueDateSlotTimeLabel(slot: CardDueDateSlot): string {
  if (slot === "anyTime") return "";
  const { hour, minute } = DUE_DATE_SLOT_TIMES[slot];
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
