// The shared DTO caps bulk card mutations at 200 ids. The UI keeps list-wide selection
// unlimited, so every bulk action batches ids per board while preserving that server contract.
export const BULK_CARD_BATCH_SIZE = 200;

type CardWithBoard = { id: string; boardId?: string };

/** Group selected card ids by their board id (Assigned Work spans multiple boards). */
export function cardIdsByBoard(
  cardIds: readonly string[],
  cards: readonly CardWithBoard[],
  fallbackBoardId: string,
): Map<string, string[]> {
  const boardByCardId = new Map(cards.map((card) => [card.id, card.boardId]));
  const result = new Map<string, string[]>();
  for (const cardId of cardIds) {
    const boardId = boardByCardId.get(cardId) ?? fallbackBoardId;
    const group = result.get(boardId);
    if (group) group.push(cardId);
    else result.set(boardId, [cardId]);
  }
  return result;
}

/** Group by board and split each group into <=200-id batches for bulk endpoints. */
export function cardIdBatchesByBoard(
  cardIds: readonly string[],
  cards: readonly CardWithBoard[],
  fallbackBoardId: string,
): Array<[string, string[]]> {
  const batches: Array<[string, string[]]> = [];
  for (const [boardId, ids] of cardIdsByBoard(cardIds, cards, fallbackBoardId)) {
    for (let offset = 0; offset < ids.length; offset += BULK_CARD_BATCH_SIZE) {
      batches.push([boardId, ids.slice(offset, offset + BULK_CARD_BATCH_SIZE)]);
    }
  }
  return batches;
}
