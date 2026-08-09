import type { WorkPrioritiesResponse, WorkPriorityItem } from "@kanera/shared/dto";

/** Where a move lands, in the same anchor vocabulary the priorities endpoint takes. */
export type PriorityAnchor = { afterId?: string | null; beforeId?: string | null };

/**
 * Turn a drop index into an anchor the server will accept.
 *
 * Shared by every queue surface — the shell drawer, the docked panel, Home's block and the Team
 * Cards priority lanes — whose drops must resolve identically. The anchor must name an entry the
 * viewer can see, or the write is rejected outright: the server deliberately refuses to reinterpret
 * a blind anchor. So when the row immediately above the drop is a redacted placeholder, anchor
 * `before` the nearest visible entry *below* instead: that lands the row after the placeholders,
 * which is where the pointer actually released it.
 *
 * `entries` are the rest coordinates — the queue without the moved row.
 */
export function priorityAnchorAt(entries: WorkPriorityItem[], index: number): PriorityAnchor {
  // The two ends need no anchor row at all, which also keeps a drop onto the very top correct
  // when the current head is a redacted placeholder.
  if (index <= 0) return { afterId: null };
  if (index >= entries.length) return { beforeId: null };
  const above = entries[index - 1];
  if (above?.card) return { afterId: above.id };
  const below = entries.slice(index).find((item) => item.card);
  if (below) return { beforeId: below.id };
  const visibleAbove = [...entries.slice(0, index)].reverse().find((item) => item.card);
  if (visibleAbove) return { afterId: visibleAbove.id };
  return { beforeId: null };
}

/**
 * A position between two neighbours, good enough to sort an optimistic row into the right slot.
 *
 * A stand-in the server response replaces; it never has to match the server's own interpolation.
 */
export function optimisticPriorityPosition(previous: string | null, next: string | null): string {
  if (previous === null && next === null) return "1000.0000000000";
  if (previous === null) return (Number(next) - 1000).toFixed(10);
  if (next === null) return (Number(previous) + 1000).toFixed(10);
  return ((Number(previous) + Number(next)) / 2).toFixed(10);
}

/**
 * Place `moving` among `rest` at the anchor and renumber ranks — the shared optimistic-reorder core
 * for the viewer's own queue, a team lane, and the drawer.
 *
 * Ranks are renumbered locally so the badges never briefly disagree with the row order. The result
 * is still a guess, not a claim: a redacted neighbour the viewer cannot see can shift every number,
 * which is why every caller settles by replacing the queue with the server's response.
 */
export function reorderedQueueItems(
  rest: WorkPrioritiesResponse["items"],
  moving: WorkPrioritiesResponse["items"][number],
  anchor: PriorityAnchor,
): WorkPrioritiesResponse["items"] {
  let previous: string | null = null;
  let next: string | null = null;
  if (anchor.afterId === null) next = rest[0]?.position ?? null;
  else if (anchor.beforeId === null) previous = rest.at(-1)?.position ?? null;
  else if (anchor.afterId) {
    const index = rest.findIndex((item) => item.id === anchor.afterId);
    previous = rest[index]?.position ?? null;
    next = index >= 0 ? rest[index + 1]?.position ?? null : null;
  } else if (anchor.beforeId) {
    const index = rest.findIndex((item) => item.id === anchor.beforeId);
    next = rest[index]?.position ?? null;
    previous = index > 0 ? rest[index - 1]?.position ?? null : null;
  }
  const position = optimisticPriorityPosition(previous, next);
  return [...rest, { ...moving, position }]
    .sort((a, b) => Number(a.position) - Number(b.position) || a.id.localeCompare(b.id))
    .map((item, index) => ({ ...item, rank: index + 1 }));
}
