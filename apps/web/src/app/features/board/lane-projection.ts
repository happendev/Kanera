import type { AnyCard, AnySeparator, BoardLaneItem } from "./board-state";

/**
 * Group immutable rows while preserving each unchanged lane's sorted array. A card move still
 * scans the source collection once, but only changed lanes sort and invalidate OnPush inputs.
 * Keep source order separately: equal positions must retain the caller's stable tie ordering.
 */
export function createSortedLaneProjection<T extends { listId: string; position: string }>(
  compare: (a: T, b: T) => number = (a, b) => Number(a.position) - Number(b.position),
) {
  let previous = new Map<string, { source: T[]; sorted: T[] }>();
  return (rows: readonly T[]): Map<string, T[]> => {
    const grouped = new Map<string, T[]>();
    for (const row of rows) {
      const lane = grouped.get(row.listId);
      if (lane) lane.push(row);
      else grouped.set(row.listId, [row]);
    }
    const next = new Map<string, { source: T[]; sorted: T[] }>();
    const result = new Map<string, T[]>();
    for (const [id, source] of grouped) {
      const old = previous.get(id);
      const entry = old && source.length === old.source.length && source.every((row, i) => row === old.source[i])
        ? old
        : { source, sorted: [...source].sort(compare) };
      next.set(id, entry);
      result.set(id, entry.sorted);
    }
    // Retain only the latest collection, so navigation/deletion releases vanished lanes.
    previous = next;
    return result;
  };
}

const EMPTY_CARDS: AnyCard[] = [];
const EMPTY_SEPARATORS: AnySeparator[] = [];
const itemPosition = (item: BoardLaneItem) => item.kind === "card" ? item.card.position : item.separator.position;

/** Reuse interleaved card/separator wrappers until that lane's actual contents change. */
export function createLaneItemsProjection(
  compare: (a: BoardLaneItem, b: BoardLaneItem) => number = (a, b) => Number(itemPosition(a)) - Number(itemPosition(b)),
) {
  const projectSeparators = createSortedLaneProjection<AnySeparator>();
  let previous = new Map<string, { cards: AnyCard[]; separators: AnySeparator[]; items: BoardLaneItem[] }>();
  return (cardsByList: ReadonlyMap<string, AnyCard[]>, separators: readonly AnySeparator[], includeSeparatorOnly = false): Map<string, BoardLaneItem[]> => {
    const separatorsByList = projectSeparators(separators);
    const ids = new Set(cardsByList.keys());
    if (includeSeparatorOnly) for (const id of separatorsByList.keys()) ids.add(id);
    const next = new Map<string, { cards: AnyCard[]; separators: AnySeparator[]; items: BoardLaneItem[] }>();
    const result = new Map<string, BoardLaneItem[]>();
    for (const id of ids) {
      const cards = cardsByList.get(id) ?? EMPTY_CARDS;
      const laneSeparators = separatorsByList.get(id) ?? EMPTY_SEPARATORS;
      const old = previous.get(id);
      const entry = old && old.cards === cards && old.separators === laneSeparators ? old : {
        cards,
        separators: laneSeparators,
        items: [
          ...cards.map((card): BoardLaneItem => ({ kind: "card", card })),
          ...laneSeparators.map((separator): BoardLaneItem => ({ kind: "separator", separator })),
        ].sort(compare),
      };
      next.set(id, entry);
      result.set(id, entry.items);
    }
    previous = next;
    return result;
  };
}
