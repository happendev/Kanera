import { describe, expect, it, vi } from "vitest";
import { createLaneItemsProjection, createSortedLaneProjection } from "./lane-projection";
import type { AnyCard, AnySeparator } from "./board-state";

const card = (id: string, listId: string, position = "1000") => ({ id, listId, position } as AnyCard);
const separator = (id: string, listId: string, position = "1500") => ({ id, listId, position } as AnySeparator);

describe("lane projections", () => {
  it("sorts only changed lanes and preserves stable tie ordering", () => {
    const compare = vi.fn((a: AnyCard, b: AnyCard) => Number(a.position) - Number(b.position));
    const project = createSortedLaneProjection(compare);
    const rows = [card("a", "one"), card("b", "one"), card("c", "two"), card("d", "two")];
    const first = project(rows);
    compare.mockClear();
    const repeated = project([...rows]);
    expect(repeated.get("one")).toBe(first.get("one"));
    expect(compare).not.toHaveBeenCalled();
    const next = project([rows[1]!, rows[0]!, rows[2]!, rows[3]!]);
    expect(next.get("one")!.map(row => row.id)).toEqual(["b", "a"]);
    expect(next.get("two")).toBe(first.get("two"));
  });

  it("updates source and target lanes without invalidating unrelated card or item arrays", () => {
    const project = createSortedLaneProjection<AnyCard>();
    const items = createLaneItemsProjection();
    const rows = [card("a", "one"), card("b", "two"), card("c", "three")];
    const separators = [separator("s", "three")];
    const beforeCards = project(rows);
    const beforeItems = items(beforeCards, separators);
    const afterCards = project([{ ...rows[0]!, listId: "two", position: "2000" }, rows[1]!, rows[2]!]);
    const afterItems = items(afterCards, separators);
    expect(afterCards.has("one")).toBe(false);
    expect(afterCards.get("two")!.map(row => row.id)).toEqual(["b", "a"]);
    expect(afterCards.get("three")).toBe(beforeCards.get("three"));
    expect(afterItems.get("three")).toBe(beforeItems.get("three"));
    const renamed = items(afterCards, [{ ...separators[0]!, title: "Changed" }]);
    expect(renamed.get("three")).not.toBe(afterItems.get("three"));
    expect(renamed.get("two")).toBe(afterItems.get("two"));
  });

  it("releases deleted lanes, supports separator-only lanes, and carries fresh card content", () => {
    const project = createSortedLaneProjection<AnyCard>();
    const items = createLaneItemsProjection();
    const a = card("a", "one");
    const first = project([a]);
    project([]);
    expect(project([a]).get("one")).not.toBe(first.get("one"));
    const fresh = project([{ ...a, title: "Renamed" }]);
    expect(fresh.get("one")![0]!.title).toBe("Renamed");
    expect(items(fresh, [separator("s", "two")]).has("two")).toBe(false);
    expect(items(fresh, [separator("s", "two")], true).get("two")![0]!.kind).toBe("separator");
  });
});
