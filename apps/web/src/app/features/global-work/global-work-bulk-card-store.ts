import type { BulkCardStore } from "../board/bulk-card-store";
import type { GlobalWorkState } from "./global-work.state";

export function globalWorkBulkCardStore(state: GlobalWorkState): BulkCardStore {
  return {
    labelIdsForCard: (id) => state.cards().find((card) => card.id === id)?.labelIds ?? [],
    assigneeIdsForCard: (id) => state.cards().find((card) => card.id === id)?.assigneeIds ?? [],
    setCardLabels: (id, ids) => state.applyCardLabels(id, ids),
    setCardAssignees: (id, ids) => state.applyCardAssignees(id, ids),
    updateCard: (card) => state.applyCardUpdate(card),
    moveCard: (id, listId, position) => {
      state.response.update((response) => ({
        ...response,
        cards: response.cards.map((card) => card.id === id ? { ...card, listId, position } : card),
      }));
    },
    // A duplicate may not match this query's scope or filters. Let the coalesced
    // query refresh decide whether it belongs instead of inserting a partial row.
    addCard: () => state.reconcileCardsInBackground(),
  };
}
