import { and, asc, desc, eq, gt, lt, type SQL } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import { db } from "../db.js";
import { badRequest } from "./errors.js";

// Fractional position helper. Positions are stored as numeric(20,10) strings; we work in
// JS numbers for arithmetic. If two neighbours get within EPS, the caller should renumber
// the list — return value `needsRebalance: true` signals that.

const STEP = 1000;
const EPS = 1e-6;

export interface PositionResult {
  position: string;
  needsRebalance: boolean;
}

export function between(prev: string | null, next: string | null): PositionResult {
  const p = prev === null ? null : Number(prev);
  const n = next === null ? null : Number(next);

  let pos: number;
  if (p === null && n === null) pos = STEP;
  else if (p === null && n !== null) pos = n - STEP;
  else if (p !== null && n === null) pos = p + STEP;
  else pos = ((p as number) + (n as number)) / 2;

  const gap =
    p !== null && n !== null ? Math.abs(n - p) : p !== null ? STEP : n !== null ? STEP : STEP;

  return { position: pos.toFixed(10), needsRebalance: gap < EPS };
}

// Used when the caller passes neighbour ids; the route handler resolves those to position strings.
export function firstPosition(): string {
  return STEP.toFixed(10);
}

export function positionAtIndex(index: number): string {
  return ((index + 1) * STEP).toFixed(10);
}

/**
 * Resolve an `{ afterId, beforeId }` anchor to the pair of positions a new position sits between.
 *
 * Every reorderable workspace entity — lists, labels, custom fields and their options, checklist
 * templates, automations, boards and board groups — resolves anchors identically, so the query
 * shape lives here once. `scope` carries the tenancy predicate (and the `archivedAt is null`
 * filter where the table has one); it is reused verbatim for both the anchor-row lookup and the
 * neighbour probe, which is what keeps a caller from anchoring to a row outside its own workspace.
 *
 * The four branches are distinguished by `null` vs `undefined`, not falsiness: `afterId: null`
 * means "move to the head" while `afterId: undefined` means "not specified", and collapsing the
 * two would turn a head-move into a no-op.
 */
export async function neighbourPositions(options: {
  table: PgTable;
  id: AnyPgColumn;
  position: AnyPgColumn;
  scope: SQL | undefined;
  afterId?: string | null;
  beforeId?: string | null;
  /** DTO field names, so the 400 still names the field the client actually sent. */
  afterLabel: string;
  beforeLabel: string;
}): Promise<{ prev: string | null; next: string | null }> {
  const { table, id, position, scope, afterId, beforeId, afterLabel, beforeLabel } = options;
  const positionOf = async (where: SQL | undefined, order: SQL) => {
    const [row] = await db.select({ position }).from(table).where(where).orderBy(order).limit(1);
    return (row?.position as string | undefined) ?? null;
  };

  let prev: string | null = null;
  let next: string | null = null;

  if (afterId === null && beforeId === undefined) {
    next = await positionOf(scope, asc(position));
  } else if (beforeId === null && afterId === undefined) {
    prev = await positionOf(scope, desc(position));
  } else if (afterId) {
    const after = await positionOf(and(eq(id, afterId), scope), asc(position));
    if (after === null) throw badRequest(`${afterLabel} not found`);
    prev = after;
    next = await positionOf(and(scope, gt(position, after)), asc(position));
  } else if (beforeId) {
    const before = await positionOf(and(eq(id, beforeId), scope), asc(position));
    if (before === null) throw badRequest(`${beforeLabel} not found`);
    next = before;
    prev = await positionOf(and(scope, lt(position, before)), desc(position));
  }

  return { prev, next };
}
