import { badRequest } from "./errors.js";

export interface LaneNeighbourItem { type: string; id: string; position: string }
export interface LaneNeighbourAnchor { type: string; id: string }

/**
 * Resolves the positions either side of an insertion point in an ordered lane.
 *
 * `afterItem: null` with `beforeItem` undefined means "the very top" and the mirror image means "the
 * very bottom"; otherwise the named anchor must exist in `items` (the caller has already filtered out
 * the moving item itself).
 */
export function resolveNeighbourPositions(
  items: readonly LaneNeighbourItem[],
  anchors: { afterItem?: LaneNeighbourAnchor | null; beforeItem?: LaneNeighbourAnchor | null },
): { prev: string | null; next: string | null } {
  const findAnchor = (anchor: LaneNeighbourAnchor) => {
    const item = items.find((candidate) => candidate.type === anchor.type && candidate.id === anchor.id);
    if (!item) throw badRequest(`${anchor.type} anchor not found`);
    return item;
  };

  let prev: string | null = null;
  let next: string | null = null;
  if (anchors.afterItem === null && anchors.beforeItem === undefined) {
    next = items[0]?.position ?? null;
  } else if (anchors.beforeItem === null && anchors.afterItem === undefined) {
    prev = items.at(-1)?.position ?? null;
  } else if (anchors.afterItem) {
    const after = findAnchor(anchors.afterItem);
    const index = items.findIndex((item) => item.type === after.type && item.id === after.id);
    prev = after.position;
    next = items[index + 1]?.position ?? null;
  } else if (anchors.beforeItem) {
    const before = findAnchor(anchors.beforeItem);
    const index = items.findIndex((item) => item.type === before.type && item.id === before.id);
    next = before.position;
    prev = items[index - 1]?.position ?? null;
  }
  return { prev, next };
}
