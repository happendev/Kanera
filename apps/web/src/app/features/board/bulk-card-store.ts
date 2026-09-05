import { InjectionToken } from "@angular/core";
import type { BoardState } from "./board-state";

/** Bulk actions share the menu, but each host owns its visible card projection. */
export type BulkCardStore = Pick<BoardState,
  "labelIdsForCard" | "assigneeIdsForCard" | "setCardLabels" | "setCardAssignees"
  | "updateCard" | "moveCard" | "addCard">;

export const BULK_CARD_STORE = new InjectionToken<BulkCardStore>("kanera.bulkCardStore");
