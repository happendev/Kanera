import type { DependencyGraphEdge } from "@kanera/shared/dto";
import { expandCardSummary, type WireCardSummary } from "@kanera/shared/events";
import { describe, expect, it } from "vitest";
import { chainNeighbourhood, layoutDependencyMap, NO_DUE_DATE, packChains, TILE_HEIGHT, weekColumnKey, weekColumnStart } from "./dependency-map.layout";

/**
 * Failure modes, each a pure-function edge case the E2E map test cannot enumerate:
 * - a card lands in the wave after its *first* blocker rather than its latest, so a connector
 *   points backwards and the step order lies;
 * - a card blocked only by cards the viewer cannot see drops off the map, or reads as ready;
 * - a done blocker still counts as blocking, so a handed-off card never reads "Ready";
 * - a blocker due after its dependent (or overdue) is not flagged at risk;
 * - "relates to" cards leak in while the toggle is off, or two separate chains merge into one;
 * - focusing a card lights unrelated siblings;
 * - tiles in one step overlap, or a lone dependent is centred on its column instead of lining up
 *   with the blockers it waits on;
 * - a connector that skips steps runs behind the tiles in between;
 * - a short chain leaves a hole under it as tall as its row's tallest chain, or a chain with more
 *   steps than fit is packed wider than the map;
 * - the critical path runs through a done card, stops short of the goal, picks the shorter of
 *   two runs, or keeps only one of two equally long runs;
 * - on the date axis a card lands in the wrong week (week starts, year ends, time zones), undated
 *   cards are mixed into a week, a blocker due after its dependent draws as a forward arrow, or two
 *   chains put the same week at different places.
 */

const NOW = new Date("2026-10-19T12:00:00Z");

function card(id: string, overrides: Partial<WireCardSummary> = {}): WireCardSummary & { inScope: boolean } {
  return {
    ...expandCardSummary({
      id, workspaceId: "ws", organisationKey: "acme", number: 1, key: `K-${id}`, listId: "list", boardId: "board",
      title: id, position: "1", createdAt: NOW, updatedAt: NOW,
    }),
    ...overrides,
    inScope: true,
  };
}

let edgeSeq = 0;
function blocks(source: string, target: string): DependencyGraphEdge {
  return { id: `e${edgeSeq++}`, sourceCardId: source, targetCardId: target, kind: "blocks" };
}
function relates(source: string, target: string): DependencyGraphEdge {
  return { id: `e${edgeSeq++}`, sourceCardId: source, targetCardId: target, kind: "relates_to" };
}

describe("layoutDependencyMap", () => {
  it("places a card one step after its latest blocker", () => {
    const layout = layoutDependencyMap(
      [card("a"), card("b", { blockedByCount: 1 }), card("c", { blockedByCount: 2 })],
      [blocks("a", "b"), blocks("b", "c"), blocks("a", "c")],
      { showRelated: false, now: NOW },
    );
    expect(layout.chains).toHaveLength(1);
    const wave = (id: string) => layout.nodesById.get(id)!.wave;
    expect([wave("a"), wave("b"), wave("c")]).toEqual([0, 1, 2]);
    expect(layout.nodesById.get("a")!.status).toBe("starter");
    expect(layout.nodesById.get("a")!.holdsUp).toBe(2);
    expect(layout.chains[0]!.goals.map((node) => node.id)).toEqual(["c"]);
  });

  it("keeps a card blocked only by unseen cards, and counts those blockers", () => {
    const layout = layoutDependencyMap(
      [card("lonely", { blockedByCount: 2 }), card("a"), card("b", { blockedByCount: 2 })],
      [blocks("a", "b")],
      { showRelated: false, now: NOW },
    );
    expect(layout.nodesById.get("lonely")).toMatchObject({ status: "blocked", offMapBlockers: 2 });
    expect(layout.nodesById.get("b")).toMatchObject({ status: "blocked", offMapBlockers: 1 });
    expect(layout.chains).toHaveLength(2);
  });

  it("reads a card whose blockers are all done as ready, and its connector as cleared", () => {
    const layout = layoutDependencyMap(
      [card("done", { completedAt: NOW }), card("next")],
      [blocks("done", "next")],
      { showRelated: false, now: NOW },
    );
    expect(layout.nodesById.get("next")!.status).toBe("ready");
    expect(layout.nodesById.get("done")!.status).toBe("done");
    expect(layout.chains[0]!.edges[0]!.cleared).toBe(true);
  });

  it("flags a blocker due after its dependent, and an overdue blocker above that", () => {
    const late = layoutDependencyMap(
      [card("blocker", { dueDateLocalDate: "2026-11-10" }), card("dependent", { dueDateLocalDate: "2026-11-01", blockedByCount: 1 })],
      [blocks("blocker", "dependent")],
      { showRelated: false, now: NOW },
    );
    expect(late.nodesById.get("dependent")!.atRisk).toBe("dueAfter");
    expect(late.chains[0]!.edges[0]!.atRisk).toBe("dueAfter");
    expect(late.totals.atRisk).toBe(1);

    const slipped = layoutDependencyMap(
      [card("blocker", { dueDateLocalDate: "2026-10-01" }), card("dependent", { blockedByCount: 1 })],
      [blocks("blocker", "dependent")],
      { showRelated: false, now: NOW },
    );
    expect(slipped.nodesById.get("dependent")!.atRisk).toBe("overdue");
  });

  it("shows related cards only when asked, without merging separate chains", () => {
    const cards = [card("a"), card("b", { blockedByCount: 1 }), card("x"), card("y", { blockedByCount: 1 }), card("note")];
    const edges = [blocks("a", "b"), blocks("x", "y"), relates("b", "note")];
    const hidden = layoutDependencyMap(cards, edges, { showRelated: false, now: NOW });
    expect(hidden.nodesById.has("note")).toBe(false);
    expect(hidden.chains).toHaveLength(2);

    const shown = layoutDependencyMap(cards, edges, { showRelated: true, now: NOW });
    expect(shown.nodesById.get("note")!.wave).toBe(shown.nodesById.get("b")!.wave + 1);
    expect(shown.chains).toHaveLength(2);
    expect(shown.chains.find((chain) => chain.nodes.some((node) => node.id === "note"))!.nodes.map((node) => node.id).sort()).toEqual(["a", "b", "note"]);
  });

  it("focuses a card's whole upstream and downstream, not its siblings", () => {
    const layout = layoutDependencyMap(
      [card("root"), card("left", { blockedByCount: 1 }), card("right", { blockedByCount: 1 }), card("end", { blockedByCount: 1 })],
      [blocks("root", "left"), blocks("root", "right"), blocks("left", "end")],
      { showRelated: false, now: NOW },
    );
    expect([...chainNeighbourhood(layout.nodesById, "left")].sort()).toEqual(["end", "left", "root"]);
  });

  it("lines a dependent up with its own blockers without overlapping tiles", () => {
    // One chain: y waits on all four starters, x only on d, the last of them.
    const layout = layoutDependencyMap(
      [card("a"), card("b"), card("c"), card("d"), card("x", { blockedByCount: 1 }), card("y", { blockedByCount: 4 })],
      [blocks("a", "y"), blocks("b", "y"), blocks("c", "y"), blocks("d", "y"), blocks("d", "x")],
      { showRelated: false, now: NOW },
    );
    expect(layout.chains).toHaveLength(1);
    const y = (id: string) => layout.nodesById.get(id)!.y;
    expect(y("x")).toBe(y("d"));
    const starters = ["a", "b", "c", "d"].map(y).sort((p, q) => p - q);
    for (let i = 1; i < starters.length; i += 1) expect(starters[i]! - starters[i - 1]!).toBeGreaterThanOrEqual(TILE_HEIGHT);
    expect(y("x") - y("y")).toBeGreaterThanOrEqual(TILE_HEIGHT);
  });
});

describe("layoutDependencyMap with tiles of different heights", () => {
  it("never overlaps tiles and aims connectors at each tile's middle", () => {
    const tall = new Set(["a", "c"]);
    const layout = layoutDependencyMap(
      [card("a"), card("b"), card("c"), card("x", { blockedByCount: 3 })],
      [blocks("a", "x"), blocks("b", "x"), blocks("c", "x")],
      { showRelated: false, now: NOW, tileHeight: (entry) => (tall.has(entry.id) ? 200 : TILE_HEIGHT) },
    );
    const column = ["a", "b", "c"].map((id) => layout.nodesById.get(id)!).sort((p, q) => p.y - q.y);
    for (let i = 1; i < column.length; i += 1) expect(column[i]!.y).toBeGreaterThanOrEqual(column[i - 1]!.y + column[i - 1]!.height);
    const edge = layout.chains[0]!.edges.find((entry) => entry.from === "a")!;
    const a = layout.nodesById.get("a")!;
    expect(edge.path.startsWith(`M ${a.x + 252} ${a.y + 100} `)).toBe(true);
    expect(layout.chains[0]!.height).toBe(Math.max(...column.map((node) => node.y + node.height)) + 16);
  });
});

describe("connectors that skip steps", () => {
  it("run through an open lane in every step they cross, clear of the tiles there", () => {
    // a → b → c → d, plus a → d skipping b's and c's steps.
    const layout = layoutDependencyMap(
      [card("a"), card("b", { blockedByCount: 1 }), card("c", { blockedByCount: 1 }), card("d", { blockedByCount: 2 })],
      [blocks("a", "b"), blocks("b", "c"), blocks("c", "d"), blocks("a", "d")],
      { showRelated: false, now: NOW },
    );
    const chain = layout.chains[0]!;
    expect(chain.nodes.map((node) => node.id).sort()).toEqual(["a", "b", "c", "d"]);
    const skip = chain.edges.find((edge) => edge.from === "a" && edge.to === "d")!;
    const straights = [...skip.path.matchAll(/ L (\S+) (\S+)/g)].map((match) => ({ x: Number(match[1]), y: Number(match[2]) }));
    expect(straights).toHaveLength(2);
    for (const { x, y } of straights) {
      const crossed = chain.nodes.filter((node) => node.x < x && x <= node.x + 252);
      expect(crossed.length).toBeGreaterThan(0);
      for (const node of crossed) expect(y < node.y || y > node.y + node.height).toBe(true);
    }
  });
});

describe("packChains", () => {
  const chain = (waves: number, height: number) => ({ waves, height, width: 308 * waves - 24 });

  it("fills the gap under a short chain before starting below the tallest", () => {
    // Three columns of two-step room each would fit three chains; the map is three chains wide.
    const { placements } = packChains([chain(2, 100), chain(2, 400), chain(2, 100), chain(2, 100)], 308 * 6);
    expect(placements[3]).toMatchObject({ x: 0, y: placements[0]!.height + 12 });
  });

  it("never packs a chain wider than the map; it scrolls inside its box instead", () => {
    const { placements } = packChains([chain(9, 100)], 1000);
    expect(placements[0]!.width).toBeLessThanOrEqual(1000);
    expect(placements[0]!.height).toBeGreaterThan(chain(9, 100).height);
  });
});

describe("critical path", () => {
  it("follows the longest run of open cards to the goal and skips done ones", () => {
    // done → a → b → c → goal, with a shortcut a → goal and a side branch x → goal.
    const layout = layoutDependencyMap(
      [card("done", { completedAt: NOW }), card("a"), card("b", { blockedByCount: 1 }), card("c", { blockedByCount: 1 }),
        card("x"), card("goal", { blockedByCount: 3 })],
      [blocks("done", "a"), blocks("a", "b"), blocks("b", "c"), blocks("c", "goal"), blocks("a", "goal"), blocks("x", "goal")],
      { showRelated: false, now: NOW },
    );
    const critical = layout.chains[0]!.critical;
    expect([...critical.nodeIds].sort()).toEqual(["a", "b", "c", "goal"]);
    expect(critical.edgeIds.size).toBe(3);
  });

  it("keeps every card on equally long runs, and only the links between them", () => {
    const layout = layoutDependencyMap(
      [card("a"), card("b", { blockedByCount: 1 }), card("c"), card("goal", { blockedByCount: 2 }), card("side", { blockedByCount: 1 })],
      [blocks("a", "goal"), blocks("c", "b"), blocks("b", "goal"), blocks("a", "side")],
      { showRelated: false, now: NOW },
    );
    const critical = layout.chains[0]!.critical;
    // c → b → goal is the only three-card run; a → goal is shorter, so a and side stay off it.
    expect([...critical.nodeIds].sort()).toEqual(["b", "c", "goal"]);
    expect(critical.edgeIds.size).toBe(2);

    const tied = layoutDependencyMap(
      [card("p"), card("q"), card("end", { blockedByCount: 2 })],
      [blocks("p", "end"), blocks("q", "end")],
      { showRelated: false, now: NOW },
    );
    expect([...tied.chains[0]!.critical.nodeIds].sort()).toEqual(["end", "p", "q"]);
  });

  it("is empty when no two open cards are chained", () => {
    const layout = layoutDependencyMap(
      [card("done", { completedAt: NOW }), card("a", { blockedByCount: 0 })],
      [blocks("done", "a")],
      { showRelated: false, now: NOW },
    );
    expect(layout.chains[0]!.critical.nodeIds.size).toBe(0);
  });
});

describe("date axis", () => {
  it("keys a day to the Monday of its week, across a year end", () => {
    expect(weekColumnStart(weekColumnKey("2026-10-19"))).toBe("2026-10-19");
    expect(weekColumnStart(weekColumnKey("2026-10-25"))).toBe("2026-10-19");
    expect(weekColumnStart(weekColumnKey("2027-01-01"))).toBe("2026-12-28");
    expect(weekColumnKey(null)).toBe(NO_DUE_DATE);
  });

  it("places cards by due week, undated first, and reverses a blocker due after its dependent", () => {
    const layout = layoutDependencyMap(
      [card("undated"), card("late", { dueDateLocalDate: "2026-11-12", blockedByCount: 1 }),
        card("early", { dueDateLocalDate: "2026-10-20", blockedByCount: 1 }), card("same", { dueDateLocalDate: "2026-10-22", blockedByCount: 1 })],
      [blocks("undated", "late"), blocks("late", "early"), blocks("undated", "same")],
      { showRelated: false, now: NOW, axis: "dates" },
    );
    const chain = layout.chains[0]!;
    expect(chain.columnKeys.map((key) => (key === NO_DUE_DATE ? "none" : weekColumnStart(key)))).toEqual(["none", "2026-10-19", "2026-11-09"]);
    const wave = (id: string) => layout.nodesById.get(id)!.wave;
    expect([wave("undated"), wave("early"), wave("same"), wave("late")]).toEqual([0, 1, 1, 2]);
    const backwards = chain.edges.find((edge) => edge.reversed)!;
    expect([backwards.from, backwards.to]).toEqual(["early", "late"]);
    expect(backwards.atRisk).toBe("dueAfter");
    expect(chain.edges.filter((edge) => edge.reversed)).toHaveLength(1);
  });

  it("gives every chain the same weeks, with this week always among them", () => {
    const layout = layoutDependencyMap(
      [card("a"), card("b", { dueDateLocalDate: "2026-11-03", blockedByCount: 1 }),
        card("x", { dueDateLocalDate: "2026-12-01" }), card("y", { dueDateLocalDate: "2026-12-02", blockedByCount: 1 })],
      [blocks("a", "b"), blocks("x", "y")],
      { showRelated: false, now: NOW, axis: "dates" },
    );
    expect(layout.chains).toHaveLength(2);
    const [first, second] = layout.chains;
    const weeks = ["none", "2026-10-19", "2026-11-02", "2026-11-30"];
    for (const chain of [first!, second!]) {
      expect(chain.columnKeys.map((key) => (key === NO_DUE_DATE ? "none" : weekColumnStart(key)))).toEqual(weeks);
      expect(chain.width).toBe(first!.width);
    }
    // The same week sits at the same x whichever chain it is in.
    expect(layout.nodesById.get("x")!.x).toBe(layout.nodesById.get("y")!.x);
    expect(layout.nodesById.get("b")!.x).toBeLessThan(layout.nodesById.get("x")!.x);
    // Steps still count steps, not weeks.
    expect([first!.steps, second!.steps]).toEqual([2, 2]);
  });
});
