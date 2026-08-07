import type { WorkPriorityItem } from "@kanera/shared/dto";

/** Where a move lands, in the same anchor vocabulary the priorities endpoint takes. */
export type PriorityAnchor = { afterId?: string | null; beforeId?: string | null };

/**
 * Turn a drop index into an anchor the server will accept.
 *
 * Shared by the Up next panel and the Team Cards priority lanes, whose drops must resolve
 * identically. The anchor must name an entry the viewer can see, or the write is rejected
 * outright — the server deliberately refuses to reinterpret a blind anchor. So when the row
 * immediately above the drop is a redacted placeholder, anchor `before` the nearest visible entry
 * *below* instead: that lands the row after the placeholders, which is where the pointer actually
 * released it.
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
