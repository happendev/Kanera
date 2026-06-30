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
