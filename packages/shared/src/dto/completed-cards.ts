import { z } from "zod";
import type { WireCardSummary } from "../events/index.js";

export const completedCardsQuery = z.object({
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  listId: z.uuid().optional(),
  boardId: z.uuid().optional(),
  q: z.string().trim().min(1).max(200).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type CompletedCardsQuery = z.infer<typeof completedCardsQuery>;

export interface CompletedCardsResponse {
  cards: WireCardSummary[];
  nextCursor: string | null;
  /**
   * The board workspace's `completedCardsActiveDays`. Carried on the response the completed panel
   * already fetches so it can explain, in the one place that holds every completed card, why cards
   * stop appearing on the board — they are hidden after this many days, never deleted. The
   * board-open payload does not ship this value, and a second request for one number is not worth it.
   */
  completedCardsActiveDays: number;
}
