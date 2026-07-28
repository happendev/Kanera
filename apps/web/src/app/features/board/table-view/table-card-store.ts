import { InjectionToken } from "@angular/core";
import type { ApiClient } from "../../../core/api/api.client";
import type { BoardState } from "../board-state";
import type { AnyCard } from "./table-view.types";

/**
 * Where a table row's optimistic write lands before its realtime echo arrives.
 *
 * The table renders against inputs, but an inline edit still has to show up immediately or the row
 * visibly lags the click. On a board that store is `BoardState`; in Global Work it is the query
 * projection in `GlobalWorkState`, which is a different shape and has its own move semantics. This
 * is the one seam between them — everything else the table does is already input-driven.
 *
 * Only the writes that change *where or how a row renders* belong here. Custom-field values are
 * deliberately absent: they do not affect row placement, so both hosts let the realtime echo apply
 * them and the table just awaits the request.
 */
export interface TableCardStore {
  updateCard(card: AnyCard): void;
  setCardAssignees(cardId: string, userIds: string[]): void;
  setCardLabels(cardId: string, labelIds: string[]): void;
  /**
   * Moves the card to the end of `listId`, owning both the optimistic placement and the request.
   * The two are one operation: each host derives the new position from its own lane model, and the
   * Global Work lane spans boards and carries personal separators the board lane knows nothing of.
   */
  moveCardToList(cardId: string, listId: string): Promise<void>;
}

export const TABLE_CARD_STORE = new InjectionToken<TableCardStore>("kanera.tableCardStore");

/** The board default. Hosts that render the table over a different projection provide their own. */
export function boardStateCardStore(state: BoardState, api: ApiClient): TableCardStore {
  return {
    updateCard: (card) => state.updateCard(card),
    setCardAssignees: (cardId, userIds) => state.setCardAssignees(cardId, userIds),
    setCardLabels: (cardId, labelIds) => state.setCardLabels(cardId, labelIds),
    moveCardToList: async (cardId, listId) => {
      const previous = state.cardById(cardId);
      if (!previous) return;
      const position = state.positionForCardDrop(cardId, listId, null, undefined);
      state.moveCard(cardId, listId, position);
      try {
        const moved = await api.post<{ id: string; listId: string; position: string }>(
          `/cards/${cardId}/move`,
          { listId, beforeCardId: null },
        );
        // The server may rebalance the mixed card/separator lane before appending. Settle from its
        // authoritative result instead of depending on the viewer receiving their own socket echo.
        state.moveCard(moved.id, moved.listId, moved.position);
      } catch (error) {
        state.moveCard(previous.id, previous.listId, previous.position);
        throw error;
      }
    },
  };
}
