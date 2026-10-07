/**
 * Applies a CDK drag-drop index move to a copy of `items`. Returns null when nothing moved so callers
 * can bail before any optimistic write.
 */
export function reorderByIndex<T>(items: readonly T[], previousIndex: number, currentIndex: number): { moved: T; reordered: T[] } | null {
  if (previousIndex === currentIndex) return null;
  const moved = items[previousIndex];
  if (moved === undefined) return null;
  const reordered = [...items];
  reordered.splice(previousIndex, 1);
  reordered.splice(currentIndex, 0, moved);
  return { moved, reordered };
}

/**
 * The `{ before<X>Id }` / `{ after<X>Id }` body every workspace-entity move route accepts: anchor
 * the moved row before its new successor when it landed at the head, otherwise after its new
 * predecessor.
 */
export function moveAnchorBody(reordered: readonly { id: string }[], currentIndex: number, beforeKey: string, afterKey: string): Record<string, string | null | undefined> {
  return currentIndex === 0
    ? { [beforeKey]: reordered[1]?.id ?? null }
    : { [afterKey]: reordered[currentIndex - 1]?.id };
}
