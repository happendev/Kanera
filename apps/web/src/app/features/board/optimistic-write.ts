/**
 * Settles one optimistic card write without letting it undo state that arrived after it.
 *
 * The caller has already shown the write's value. While the request is in flight, realtime can
 * deliver something newer for the same card: a teammate's move or assignment, a rebalance, or the
 * viewer's own next gesture. Either outcome of this request is older than that, so it settles only
 * while the optimistic value is still showing:
 * - A failure restores the previous value. A failed request publishes no realtime echo, so a
 *   rollback over newer state would stay wrong until the next reload.
 * - A success applies its response. If the value has moved on, the realtime stream (which carries
 *   this write's own echo in commit order) has already settled it, and a late response would put
 *   back state that a newer event replaced.
 *
 * The Board and Global Work stores both settle through this; each supplies how it reads and writes
 * its own projection.
 */
export async function settleOptimisticWrite<T>(write: {
  /** True while the store still shows the value this write applied optimistically. */
  showing: () => boolean;
  request: () => Promise<T>;
  settle?: (result: T) => void;
  rollback: () => void;
}): Promise<T> {
  let result: T;
  try {
    result = await write.request();
  } catch (error) {
    if (write.showing()) write.rollback();
    throw error;
  }
  if (write.showing()) write.settle?.(result);
  return result;
}

/** A card's place in its lane, as both the Board and Global Work stores hold it. */
export type CardPlacement = { listId: string; position: string };

export function holdsPlacement(card: CardPlacement | null | undefined, placement: CardPlacement): boolean {
  return card?.listId === placement.listId && card.position === placement.position;
}
