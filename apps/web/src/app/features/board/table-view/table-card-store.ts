import { InjectionToken } from "@angular/core";
import type { ApiClient } from "../../../core/api/api.client";
import type { BoardState } from "../board-state";
import { captureBoardCustomFieldWrite, type SettleCustomFieldWrite } from "../custom-field-write";
import type { ReportedInProgressClock } from "../time-in-progress.util";
import type { AnyCard } from "./table-view.types";

/**
 * Where a table row's optimistic write lands before its realtime echo arrives.
 *
 * The table renders against inputs, but an inline edit still has to show up immediately or the row
 * visibly lags the click. On a board that store is `BoardState`; in Global Work it is the query
 * projection in `GlobalWorkState`, which is a different shape and has its own move semantics. This
 * is the one seam between them — everything else the table does is already input-driven.
 *
 * Custom-field replacement writes also settle here: a second picker gesture must build on the
 * acknowledged value even when the websocket echo has not arrived yet.
 */
export interface TableCardStore {
  updateCard(card: AnyCard): void;
  setCardAssignees(cardId: string, userIds: string[]): void;
  setCardLabels(cardId: string, labelIds: string[]): void;
  captureCustomFieldWrite(cardId: string, fieldId: string, boardId: string): SettleCustomFieldWrite;
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
    captureCustomFieldWrite: (cardId, fieldId, boardId) => captureBoardCustomFieldWrite(state, cardId, fieldId, boardId),
    moveCardToList: async (cardId, listId) => {
      if (!state.cardById(cardId)) return;
      const position = state.positionForCardDrop(cardId, listId, null, undefined);
      // The server may rebalance the mixed card/separator lane before appending; sendCardMove
      // settles from its result rather than depending on the viewer receiving their own echo.
      await state.sendCardMove(cardId, listId, position, () => api.post<{ id: string; listId: string; position: string } & ReportedInProgressClock>(
        `/cards/${cardId}/move`,
        { listId, beforeCardId: null },
      ));
    },
  };
}
