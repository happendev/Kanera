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
}
