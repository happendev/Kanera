import type { DependencyGraphEdge } from "@kanera/shared/dto";
import type { WireCardSummary } from "@kanera/shared/events";
import { localDateKey } from "../../shared/day-key.util";
import { dueDateTimestamp } from "../board/due-date.util";

/**
 * Pure layout for the Dependencies view. The server hands over cards and edges; this turns them
 * into chains (connected groups of cards), waves (columns: a card sits one wave to the right of its
 * latest blocker, so wave 1 is "can start now" and every wave after it waits on the one before),
 * row order within each wave, and fixed tile geometry the SVG connectors are drawn from.
 *
 * Geometry is computed rather than measured: tiles have a fixed size, so the connectors never wait
 * on a layout pass and the same data always draws the same map.
 */

export const TILE_WIDTH = 252;
/** The height of a tile with nothing beyond its key, title, people and date. */
export const TILE_HEIGHT = 96;
export const WAVE_GAP = 56;
const ROW_GAP = 14;
export const MAP_PADDING = 16;

/**
 * How a card stands in its chains. `blocked`: an open blocker is still holding it (visible or not).
 * `ready`: it had blockers and every one is now done, so it has been handed off. `starter`: nothing
 * holds it, but it holds other open work up, which makes it where effort unblocks the most.
 */
export type DependencyStatus = "done" | "blocked" | "ready" | "starter" | "open";

export type DependencyFilter = "all" | "blocked" | "ready" | "starter" | "atRisk";

export type AtRiskReason = "overdue" | "dueAfter";

export interface MapNode {
  id: string;
  card: WireCardSummary;
  inScope: boolean;
  status: DependencyStatus;
  wave: number;
  x: number;
  y: number;
  /** Tiles grow with what they show (labels, fields), so each carries its own height. */
  height: number;
  /** Open blockers the map does not show: on boards the viewer cannot open, or past the card cap. */
  offMapBlockers: number;
  /** Open cards this one holds up, directly or further down the chain. */
  holdsUp: number;
  /** Set when an open blocker of this card is overdue or due after it. */
  atRisk: AtRiskReason | null;
  blockerIds: string[];
  dependentIds: string[];
  relatedIds: string[];
}

/** Anything ordered and placed in a step: a card's tile, or a lane a connector runs through. */
interface LayoutItem {
  id: string;
  wave: number;
  x: number;
  y: number;
  height: number;
}

/** Left-to-right neighbours for ordering and placement, with lanes standing in for skipped steps. */
interface Links {
  up: Map<string, string[]>;
  down: Map<string, string[]>;
}

export interface MapEdge {
  id: string;
  /** The left end of the drawn connector; `to` is the right end. */
  from: string;
  to: string;
  kind: DependencyGraphEdge["kind"];
  /**
   * The blocker sits to the right of the card it blocks, so the arrow points back. Only the date
   * axis does this: a blocker due later than its dependent, which is what puts that link at risk.
   */
  reversed: boolean;
  /** The blocker is done: the edge is history, drawn quietly. */
  cleared: boolean;
  atRisk: AtRiskReason | null;
  path: string;
}

export interface MapChain {
  /** The id of the chain's first card in stable order, so a chain keeps its identity across re-reads. */
  id: string;
  nodes: MapNode[];
  edges: MapEdge[];
  /** Columns: steps, or weeks on the date axis. */
  waves: number;
  /** How many steps the chain's cards take, whichever axis lays them out. */
  steps: number;
  width: number;
  height: number;
  /** The cards nothing on the map waits for: what the chain is working toward. */
  goals: MapNode[];
  /**
   * What each column was compacted from: on the date axis, the Monday (as a day number) of the week
   * its cards are due, or NO_DUE_DATE; on the step axis, the step in the whole map's graph.
   */
  columnKeys: number[];
  /**
   * Every card on a longest run of open cards, each blocked by the one before: the work that decides
   * when the chain can finish. Empty when no two open cards are chained.
   */
  critical: { nodeIds: ReadonlySet<string>; edgeIds: ReadonlySet<string> };
  counts: { blocked: number; ready: number; starter: number; atRisk: number; done: number };
}

export interface DependencyMapLayout {
  chains: MapChain[];
  nodesById: Map<string, MapNode>;
  totals: MapChain["counts"] & { cards: number };
}

/**
 * `steps`: a card sits one column right of its latest blocker. `dates`: a card sits in the column of
 * the week it is due, undated cards first, and only weeks that hold a card get a column, so a quiet
 * month does not stretch the chain.
 */
export type MapAxis = "steps" | "dates";

/** The date axis's column for cards without a due date; sorts before every week. */
export const NO_DUE_DATE = Number.NEGATIVE_INFINITY;
const DAY_MS = 86_400_000;

/**
 * The date axis's column key for a calendar day: the day number of the Monday that starts its week,
 * as every calendar grid in the app starts weeks on Monday (shared/week-start.ts).
 */
export function weekColumnKey(dateKey: string | null | undefined): number {
  if (!dateKey) return NO_DUE_DATE;
  const [year, month, day] = dateKey.split("-").map(Number);
  const dayNumber = Math.round(Date.UTC(year!, month! - 1, day!) / DAY_MS);
  // Day 0 (1 January 1970) was a Thursday, three days after a Monday.
  return dayNumber - (((dayNumber + 3) % 7) + 7) % 7;
}

/** The YYYY-MM-DD day a week column starts on, for its heading. */
export function weekColumnStart(key: number): string {
  return new Date(key * DAY_MS).toISOString().slice(0, 10);
}

/** Wire summaries and live board cards both fit; the board omits some fields it never sets. */
type RiskCard = Partial<Pick<WireCardSummary, "completedAt" | "archivedAt" | "dueDateLocalDate" | "dueDateSlot" | "dueDateTimezone">>;

/**
 * Jira calls these off-track dependencies: the dependent cannot finish on time if its blocker
 * finishes on time (due after it), or the blocker has already slipped (overdue). Only open pairs
 * count; a cleared blocker cannot put anything at risk. The board overview's At risk count and the
 * portfolio's (`dependencyAtRiskSql` in the API) use this same rule.
 */
export function dependencyRisk(blocker: RiskCard | undefined, dependent: RiskCard | undefined, now: number): AtRiskReason | null {
  if (!blocker || !dependent || blocker.completedAt || blocker.archivedAt || dependent.completedAt || dependent.archivedAt) return null;
  const blockerDue = dueDateTimestamp(blocker.dueDateLocalDate, blocker.dueDateSlot, blocker.dueDateTimezone);
  if (blockerDue !== null && blockerDue <= now) return "overdue";
  const dependentDue = dueDateTimestamp(dependent.dueDateLocalDate, dependent.dueDateSlot, dependent.dueDateTimezone);
  if (blockerDue !== null && dependentDue !== null && blockerDue > dependentDue) return "dueAfter";
  return null;
}

export interface LayoutOptions {
  /** Draw `relates_to` edges and keep cards that only relate to the chain. */
  showRelated: boolean;
  axis?: MapAxis;
  now?: Date;
  /** A tile's height for a card; every tile is TILE_HEIGHT when omitted. */
  tileHeight?: (card: WireCardSummary) => number;
}

export function layoutDependencyMap(
  cards: readonly (WireCardSummary & { inScope: boolean })[],
  edges: readonly DependencyGraphEdge[],
  options: LayoutOptions,
): DependencyMapLayout {
  const now = options.now ?? new Date();
  const byId = new Map(cards.map((card) => [card.id, card]));
  const blockers = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();
  const related = new Map<string, string[]>();
  const push = (map: Map<string, string[]>, key: string, value: string) => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };
  const visibleEdges = edges.filter((edge) =>
    byId.has(edge.sourceCardId) && byId.has(edge.targetCardId) && (edge.kind === "blocks" || options.showRelated)
  );
  for (const edge of visibleEdges) {
    if (edge.kind === "blocks") {
      push(blockers, edge.targetCardId, edge.sourceCardId);
      push(dependents, edge.sourceCardId, edge.targetCardId);
    } else {
      push(related, edge.sourceCardId, edge.targetCardId);
      push(related, edge.targetCardId, edge.sourceCardId);
    }
  }

  const isOpen = (id: string) => {
    const card = byId.get(id);
    return Boolean(card && !card.completedAt && !card.archivedAt);
  };
  const edgeRisk = (blockerId: string, dependentId: string): AtRiskReason | null =>
    dependencyRisk(byId.get(blockerId), byId.get(dependentId), now.getTime());

  // A card stays on the map only when the map can say something about it: it has a drawn edge, or
  // it is blocked by cards the map cannot show (so "blocked by 1 card you can't access" has a home).
  const keep = cards.filter((card) =>
    blockers.has(card.id) || dependents.has(card.id) || related.has(card.id)
    || (isOpen(card.id) && (card.blockedByCount ?? 0) > 0)
  );

  // Waves: longest path from a card with no blockers. The server keeps `blocks` acyclic; the
  // `visiting` guard only stops a corrupt graph from hanging the tab.
  const wave = new Map<string, number>();
  const visiting = new Set<string>();
  const waveOf = (id: string): number => {
    const known = wave.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const value = Math.max(-1, ...(blockers.get(id) ?? []).map(waveOf)) + 1;
    visiting.delete(id);
    wave.set(id, value);
    return value;
  };
  for (const card of keep) waveOf(card.id);
  // A card tied to its chain only by "relates to" sits one wave right of the card it relates to,
  // so its dashed connector reads left to right like every other edge.
  for (const card of keep) {
    if (blockers.has(card.id) || dependents.has(card.id)) continue;
    const anchors = (related.get(card.id) ?? []).filter((id) => blockers.has(id) || dependents.has(id));
    if (anchors.length) wave.set(card.id, Math.min(...anchors.map((id) => wave.get(id) ?? 0)) + 1);
  }

  const holdsUpMemo = new Map<string, Set<string>>();
  const downstream = (id: string): Set<string> => {
    const known = holdsUpMemo.get(id);
    if (known) return known;
    const result = new Set<string>();
    holdsUpMemo.set(id, result);
    for (const next of dependents.get(id) ?? []) {
      if (!isOpen(next)) continue;
      result.add(next);
      for (const further of downstream(next)) result.add(further);
    }
    return result;
  };

  const nodesById = new Map<string, MapNode>();
  for (const card of keep) {
    const cardBlockers = blockers.get(card.id) ?? [];
    const openVisibleBlockers = cardBlockers.filter(isOpen).length;
    const offMapBlockers = Math.max(0, (card.blockedByCount ?? 0) - openVisibleBlockers);
    const open = isOpen(card.id);
    const holdsUp = open ? downstream(card.id).size : 0;
    const blocked = open && (openVisibleBlockers > 0 || offMapBlockers > 0);
    const status: DependencyStatus = !open
      ? "done"
      : blocked
        ? "blocked"
        : cardBlockers.length > 0
          ? "ready"
          : holdsUp > 0
            ? "starter"
            : "open";
    const risks = cardBlockers.map((blockerId) => edgeRisk(blockerId, card.id)).filter((risk) => risk !== null);
    nodesById.set(card.id, {
      id: card.id,
      card,
      inScope: card.inScope,
      status,
      wave: wave.get(card.id) ?? 0,
      x: 0,
      y: 0,
      height: options.tileHeight?.(card) ?? TILE_HEIGHT,
      offMapBlockers,
      holdsUp,
      // Overdue outranks "due after": it has already slipped, the other only will.
      atRisk: risks.includes("overdue") ? "overdue" : risks[0] ?? null,
      blockerIds: cardBlockers.filter((id) => byId.has(id)),
      dependentIds: (dependents.get(card.id) ?? []).filter((id) => byId.has(id)),
      relatedIds: (related.get(card.id) ?? []).filter((id) => byId.has(id)),
    });
  }

  // The date axis is one calendar for the whole map: every chain gets the same week columns, so a
  // week sits at the same x in every chain and the lanes read down like a Gantt chart. This week is
  // always a column, as the anchor everything else is read against.
  let axis: number[] | null = null;
  const stepOf = new Map([...nodesById.values()].map((node) => [node.id, node.wave]));
  if (options.axis === "dates") {
    for (const node of nodesById.values()) node.wave = weekColumnKey(node.card.dueDateLocalDate);
    axis = [...new Set([...[...nodesById.values()].map((node) => node.wave), weekColumnKey(localDateKey(now))])].sort((a, b) => a - b);
  }

  const chains = connectedChains(nodesById).map((members) => buildChain(members, visibleEdges, nodesById, edgeRisk, axis, stepOf));
  chains.sort(compareChains);
  const totals = { cards: nodesById.size, blocked: 0, ready: 0, starter: 0, atRisk: 0, done: 0 };
  for (const chain of chains) {
    for (const key of ["blocked", "ready", "starter", "atRisk", "done"] as const) totals[key] += chain.counts[key];
  }
  return { chains, nodesById, totals };
}

/** Whether a card answers the active filter. Chains are kept whole around any card that does. */
export function nodeMatchesFilter(node: MapNode, filter: DependencyFilter): boolean {
  switch (filter) {
    case "all": return true;
    case "atRisk": return node.atRisk !== null;
    default: return node.status === filter;
  }
}

/** A card's blockers and dependents, all the way up and down: what lights up when it is focused. */
export function chainNeighbourhood(nodesById: ReadonlyMap<string, MapNode>, id: string): Set<string> {
  const result = new Set<string>([id]);
  const walk = (start: string, next: (node: MapNode) => string[]) => {
    const stack = [start];
    while (stack.length) {
      const node = nodesById.get(stack.pop()!);
      if (!node) continue;
      for (const neighbour of next(node)) {
        if (result.has(neighbour)) continue;
        result.add(neighbour);
        stack.push(neighbour);
      }
    }
  };
  walk(id, (node) => node.blockerIds);
  walk(id, (node) => node.dependentIds);
  for (const neighbour of nodesById.get(id)?.relatedIds ?? []) result.add(neighbour);
  return result;
}

function connectedChains(nodesById: ReadonlyMap<string, MapNode>): MapNode[][] {
  const seen = new Set<string>();
  const chains: MapNode[][] = [];
  for (const node of [...nodesById.values()].sort(compareNodes)) {
    if (seen.has(node.id)) continue;
    const members: MapNode[] = [];
    const stack = [node.id];
    seen.add(node.id);
    while (stack.length) {
      const current = nodesById.get(stack.pop()!)!;
      members.push(current);
      for (const next of [...current.blockerIds, ...current.dependentIds, ...current.relatedIds]) {
        if (seen.has(next) || !nodesById.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    chains.push(members);
  }
  return chains;
}

function buildChain(
  members: MapNode[],
  edges: readonly DependencyGraphEdge[],
  nodesById: ReadonlyMap<string, MapNode>,
  edgeRisk: (blockerId: string, dependentId: string) => AtRiskReason | null,
  axis: readonly number[] | null,
  stepOf: ReadonlyMap<string, number>,
): MapChain {
  // Steps are global longest paths; compact them per chain so a chain that starts deep in the
  // workspace's graph still starts at the left edge of its own box. Weeks keep the shared axis.
  const usedWaves = axis ? [...axis] : [...new Set(members.map((node) => node.wave))].sort((a, b) => a - b);
  const waveIndex = new Map(usedWaves.map((value, index) => [value, index]));
  for (const node of members) node.wave = waveIndex.get(node.wave) ?? 0;
  const cardColumns: MapNode[][] = usedWaves.map(() => []);
  for (const node of members) cardColumns[node.wave]!.push(node);
  for (const column of cardColumns) column.sort(compareNodes);
  const columns: LayoutItem[][] = cardColumns.map((column) => [...column]);

  const memberIds = new Set(members.map((node) => node.id));
  const relations = edges
    .filter((edge) => memberIds.has(edge.sourceCardId) && memberIds.has(edge.targetCardId))
    .map((edge) => {
      const from = nodesById.get(edge.sourceCardId)!;
      const to = nodesById.get(edge.targetCardId)!;
      // Connectors run left to right. `relates_to` is stored smaller-id first, and on the date axis
      // a blocker can be due after the card it blocks; either way the right-hand end goes last.
      const [left, right] = to.wave < from.wave ? [to, from] : [from, to];
      return { edge, from, to, left, right };
    });

  // A connector that skips steps gets a lane: a zero-height slot in every step it crosses, which
  // ordering and placement treat like a card. The connector then runs through the gap that slot
  // keeps open between tiles instead of behind them, and the dependent lines up with the lane.
  const links: Links = { up: new Map(), down: new Map() };
  const link = (from: string, to: string) => {
    links.down.set(from, [...(links.down.get(from) ?? []), to]);
    links.up.set(to, [...(links.up.get(to) ?? []), from]);
  };
  const lanes = new Map<string, LayoutItem[]>();
  for (const { edge, left, right } of relations) {
    if (right.wave === left.wave) continue;
    const lane: LayoutItem[] = [];
    let previous = left.id;
    for (let wave = left.wave + 1; wave < right.wave; wave += 1) {
      const slot: LayoutItem = { id: `${edge.id}:${wave}`, wave, x: 0, y: 0, height: 0 };
      columns[wave]!.push(slot);
      lane.push(slot);
      link(previous, slot.id);
      previous = slot.id;
    }
    link(previous, right.id);
    lanes.set(edge.id, lane);
  }

  orderColumns(columns, links);
  placeRows(columns, links);
  columns.forEach((column, index) => {
    for (const item of column) item.x = MAP_PADDING + index * (TILE_WIDTH + WAVE_GAP);
  });
  const bottom = Math.max(...columns.flat().map((item) => item.y + item.height));

  const chainEdges: MapEdge[] = relations.map(({ edge, from, to, left, right }) => ({
    id: edge.id,
    from: left.id,
    to: right.id,
    kind: edge.kind,
    reversed: edge.kind === "blocks" && left !== from,
    cleared: edge.kind === "blocks" && from.status === "done",
    atRisk: edge.kind === "blocks" ? edgeRisk(from.id, to.id) : null,
    path: connectorPath(left, right, lanes.get(edge.id)),
  }));

  const counts = { blocked: 0, ready: 0, starter: 0, atRisk: 0, done: 0 };
  for (const node of members) {
    if (node.status === "blocked" || node.status === "ready" || node.status === "starter" || node.status === "done") counts[node.status] += 1;
    if (node.atRisk) counts.atRisk += 1;
  }
  const lastColumn = cardColumns[cardColumns.length - 1] ?? [];
  const goals = members.filter((node) => node.dependentIds.length === 0 && node.blockerIds.length > 0);
  return {
    id: [...members].sort(compareNodes)[0]!.id,
    nodes: columns.flat().filter((item) => memberIds.has(item.id)).map((item) => nodesById.get(item.id)!),
    edges: chainEdges,
    waves: columns.length,
    steps: new Set(members.map((node) => stepOf.get(node.id))).size,
    width: MAP_PADDING * 2 + columns.length * TILE_WIDTH + (columns.length - 1) * WAVE_GAP,
    height: bottom + MAP_PADDING,
    goals: goals.length ? goals.sort(compareNodes) : lastColumn,
    columnKeys: usedWaves,
    critical: criticalPath(members, relations.filter(({ edge }) => edge.kind === "blocks").map(({ edge }) => edge)),
    counts,
  };
}

/**
 * The critical path, as Gantt tools draw it, measured in cards because Kanera cards carry no
 * durations: the longest run of open cards where each is blocked by the one before. When several
 * runs tie, every card on any of them is critical, as a task with no slack is in a Gantt chart;
 * picking one would be arbitrary and hide work that delays the goal just as much.
 */
function criticalPath(members: readonly MapNode[], edges: readonly DependencyGraphEdge[]): MapChain["critical"] {
  const open = new Map(members.filter((node) => node.status !== "done").map((node) => [node.id, node]));
  // Longest open run ending at a card (`upTo`) and starting from it (`onFrom`), each counting it.
  const longest = (next: (node: MapNode) => string[]) => {
    const memo = new Map<string, number>();
    const visiting = new Set<string>();
    const of = (id: string): number => {
      const known = memo.get(id);
      if (known !== undefined) return known;
      if (visiting.has(id)) return 1;
      visiting.add(id);
      const value: number = 1 + Math.max(0, ...next(open.get(id)!).filter((other) => open.has(other)).map(of));
      visiting.delete(id);
      memo.set(id, value);
      return value;
    };
    return of;
  };
  const upTo = longest((node) => node.blockerIds);
  const onFrom = longest((node) => node.dependentIds);
  const span = Math.max(0, ...[...open.keys()].map(upTo));
  if (span < 2) return { nodeIds: new Set(), edgeIds: new Set() };
  const onPath = (id: string) => open.has(id) && upTo(id) + onFrom(id) - 1 === span;
  const nodeIds = new Set([...open.keys()].filter(onPath));
  const edgeIds = new Set(edges
    .filter((edge) => onPath(edge.sourceCardId) && onPath(edge.targetCardId) && upTo(edge.targetCardId) === upTo(edge.sourceCardId) + 1)
    .map((edge) => edge.id));
  return { nodeIds, edgeIds };
}

/**
 * Barycentre ordering, the standard crossing-reduction pass for layered graphs: each card moves
 * toward the average row of its neighbours in the wave beside it. A few alternating sweeps settle
 * it; ties keep the stable order, so an unchanged graph never shuffles between re-reads.
 */
function orderColumns(columns: LayoutItem[][], links: Links): void {
  const rowOf = new Map<string, number>();
  const index = () => columns.forEach((column) => column.forEach((node, row) => rowOf.set(node.id, row)));
  index();
  const sweep = (column: LayoutItem[], neighbours: ReadonlyMap<string, string[]>) => {
    const score = new Map(column.map((node, row) => {
      const rows = (neighbours.get(node.id) ?? []).map((id) => rowOf.get(id)).filter((value): value is number => value !== undefined);
      return [node.id, rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : row];
    }));
    column.sort((a, b) => score.get(a.id)! - score.get(b.id)!);
    column.forEach((node, row) => rowOf.set(node.id, row));
  };
  for (let pass = 0; pass < 4; pass += 1) {
    if (pass % 2 === 0) {
      for (let i = 1; i < columns.length; i += 1) sweep(columns[i]!, links.up);
    } else {
      for (let i = columns.length - 2; i >= 0; i -= 1) sweep(columns[i]!, links.down);
    }
  }
}

/** Narrow chains put badges below the title; packing must reserve the same height as the header. */
export function chainHeaderHeight(width: number): number {
  return width <= 640 ? 64 : 40;
}
/** The "Step N" row at the top of a chain's canvas. */
export const STEP_LABEL_HEIGHT = 22;
const CHAIN_GAP = 12;
const CHAIN_BORDER = 1;
/**
 * One packing column per step: a chain of n steps spans n columns, and a span is exactly wide
 * enough for its tiles because the gap between steps covers the box's padding, borders and the gap
 * between boxes.
 */
const STEP_PITCH = TILE_WIDTH + WAVE_GAP;
/** Room under a chain wider than its box, so a classic scrollbar does not cover its last row. */
const SCROLLBAR_ALLOWANCE = 12;

export interface ChainPlacement {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Places chain boxes for the map layout: each takes the highest free spot across the columns it
 * spans, leftmost first, in the order given. Wrapping boxes in a flex row left a gap under every
 * short chain as tall as the row's tallest one; this packs the next chain into that gap instead,
 * while the most urgent chains still come first. Positions are computed, not measured, so a chain
 * never jumps after it renders.
 */
export function packChains(chains: readonly Pick<MapChain, "waves" | "width" | "height">[], containerWidth: number): {
  placements: ChainPlacement[];
  height: number;
} {
  const columns = Math.max(1, Math.floor((containerWidth + CHAIN_GAP) / STEP_PITCH));
  const bottoms = new Array<number>(columns).fill(0);
  const placements = chains.map((chain) => {
    const span = Math.min(chain.waves, columns);
    // A single column takes the full width: on a phone there is nothing to share the row with.
    const width = columns === 1 ? Math.max(0, containerWidth) : span * STEP_PITCH - CHAIN_GAP;
    const scrolls = chain.width + CHAIN_BORDER * 2 > width;
    const height = CHAIN_BORDER * 2 + chainHeaderHeight(width) + STEP_LABEL_HEIGHT + chain.height + (scrolls ? SCROLLBAR_ALLOWANCE : 0);
    let column = 0;
    let y = Infinity;
    for (let start = 0; start + span <= columns; start += 1) {
      const top = Math.max(...bottoms.slice(start, start + span));
      if (top < y) {
        y = top;
        column = start;
      }
    }
    for (let index = column; index < column + span; index += 1) bottoms[index] = y + height + CHAIN_GAP;
    return { x: column * STEP_PITCH, y, width, height };
  });
  return { placements, height: Math.max(0, Math.max(...bottoms) - CHAIN_GAP) };
}

/**
 * Vertical placement: each card's middle sits as close as it can to the average middle of its
 * neighbours in the wave beside it, so a lone dependent lines up with the blockers it waits on
 * instead of being centred against the whole column, and connectors stay as straight as the order
 * allows. Rows keep the order `orderColumns` chose and never overlap, whatever each tile's height.
 * Sweeps run right, left, then right again, so the last word belongs to the blockers: a chain reads
 * from its starting cards outward.
 */
function placeRows(columns: LayoutItem[][], links: Links): void {
  const byId = new Map(columns.flat().map((item) => [item.id, item]));
  for (const column of columns) {
    let y = 0;
    for (const node of column) {
      node.y = y;
      y += node.height + ROW_GAP;
    }
  }
  const settle = (column: LayoutItem[], neighbours: ReadonlyMap<string, string[]>) => {
    const desired = column.map((node) => {
      const middles = (neighbours.get(node.id) ?? [])
        .map((id) => byId.get(id))
        .filter((other) => other !== undefined)
        .map(middle);
      return middles.length ? middles.reduce((sum, value) => sum + value, 0) / middles.length : middle(node);
    });
    // Least-squares fit under "same order, no overlap": runs of cards that would collide merge into
    // one block whose top is the mean of what its members want, each less its offset in the block.
    type Block = { members: number[]; top: number; extent: number };
    const fit = (members: number[]): Block => {
      let offset = 0;
      let total = 0;
      for (const index of members) {
        total += desired[index]! - (offset + column[index]!.height / 2);
        offset += column[index]!.height + ROW_GAP;
      }
      return { members, top: total / members.length, extent: offset };
    };
    const blocks: Block[] = [];
    column.forEach((_, index) => {
      let block = fit([index]);
      for (let prev = blocks.at(-1); prev && prev.top + prev.extent > block.top; prev = blocks.at(-1)) {
        blocks.pop();
        block = fit([...prev.members, ...block.members]);
      }
      blocks.push(block);
    });
    for (const block of blocks) {
      let y = block.top;
      for (const index of block.members) {
        column[index]!.y = y;
        y += column[index]!.height + ROW_GAP;
      }
    }
  };
  for (const forward of [true, false, true]) {
    if (forward) {
      for (let i = 1; i < columns.length; i += 1) settle(columns[i]!, links.up);
    } else {
      for (let i = columns.length - 2; i >= 0; i -= 1) settle(columns[i]!, links.down);
    }
  }
  const top = Math.min(...columns.flat().map((node) => node.y));
  for (const node of columns.flat()) node.y = Math.round(node.y - top) + MAP_PADDING;
}

const middle = (item: LayoutItem) => item.y + item.height / 2;

/**
 * A connector from the right edge of one tile to the left edge of another: curves across each gap
 * between steps and runs straight through the lane it holds in every step it skips. Two tiles of
 * one step get an arc instead. Always drawn left to right; a reversed edge puts its arrow at the start.
 */
function connectorPath(from: LayoutItem, to: LayoutItem, lane: readonly LayoutItem[] = []): string {
  if (to.x <= from.x) {
    const x = from.x + TILE_WIDTH;
    const bulge = WAVE_GAP * 0.6;
    return `M ${x} ${middle(from)} C ${x + bulge} ${middle(from)}, ${x + bulge} ${middle(to)}, ${x} ${middle(to)}`;
  }
  let x = from.x + TILE_WIDTH;
  let y = middle(from);
  let path = `M ${x} ${y}`;
  const cross = (toX: number, toY: number) => {
    const dx = Math.max(24, (toX - x) / 2);
    path += ` C ${x + dx} ${y}, ${toX - dx} ${toY}, ${toX} ${toY}`;
    x = toX;
    y = toY;
  };
  for (const slot of lane) {
    cross(slot.x, middle(slot));
    x = slot.x + TILE_WIDTH;
    path += ` L ${x} ${y}`;
  }
  cross(to.x, middle(to));
  return path;
}

const STATUS_ORDER: Record<DependencyStatus, number> = { starter: 0, blocked: 1, ready: 2, open: 3, done: 4 };

/** Stable order inside a wave before crossing reduction: actionable first, then by due date, then key. */
function compareNodes(a: MapNode, b: MapNode): number {
  return STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
    || (a.card.dueDateLocalDate ?? "9999").localeCompare(b.card.dueDateLocalDate ?? "9999")
    || a.card.key.localeCompare(b.card.key, undefined, { numeric: true })
    || a.id.localeCompare(b.id);
}

/** Chains needing attention first: at risk, then most blocked work, then biggest. */
function compareChains(a: MapChain, b: MapChain): number {
  return b.counts.atRisk - a.counts.atRisk
    || b.counts.blocked - a.counts.blocked
    || b.nodes.length - a.nodes.length
    || a.id.localeCompare(b.id);
}
