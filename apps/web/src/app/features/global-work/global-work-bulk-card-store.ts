import type { BulkCardStore } from "../board/bulk-card-store";
import { compactInProgressClock, resolveInProgressClock } from "../board/time-in-progress.util";
import type { GlobalWorkState } from "./global-work.state";

export function globalWorkBulkCardStore(state: GlobalWorkState): BulkCardStore {
  return {
    labelIdsForCard: (id) => state.cards().find((card) => card.id === id)?.labelIds ?? [],
    assigneeIdsForCard: (id) => state.cards().find((card) => card.id === id)?.assigneeIds ?? [],
    setCardLabels: (id, ids) => state.applyCardLabels(id, ids),
    setCardAssignees: (id, ids) => state.applyCardAssignees(id, ids),
    updateCard: (card) => state.applyCardUpdate(card),
    moveCard: (id, listId, position, clock) => {
      state.response.update((response) => ({
        ...response,
        cards: response.cards.map((card) => card.id === id
          ? {
              ...card,
              listId,
              position,
              // The bulk route's cards carry the persisted clock.
              ...(clock && (compactInProgressClock(resolveInProgressClock(card, clock)) as Partial<typeof card>)),
            }
          : card),
      }));
    },
    // A duplicate may not match this query's scope or filters. Let the coalesced
    // query refresh decide whether it belongs instead of inserting a partial row.
    addCard: () => state.reconcileCardsInBackground(),
  };
}
