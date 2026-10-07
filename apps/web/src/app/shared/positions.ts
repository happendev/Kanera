/** The row with `id` carrying a new position; every other row is returned as-is. */
export function withPosition<T extends { id: string; position: string }>(items: readonly T[], id: string, position: string): T[] {
  return items.map((item) => (item.id === id ? { ...item, position } : item));
}

/** Applies a `*:rebalanced` payload: rows named in `positions` take their new position, the rest are untouched. */
export function applyPositions<T extends { id: string; position: string }>(items: readonly T[], positions: readonly { id: string; position: string }[]): T[] {
  const positionsById = new Map(positions.map((p) => [p.id, p.position]));
  return items.map((item) => {
    const next = positionsById.get(item.id);
    return next ? { ...item, position: next } : item;
  });
}
