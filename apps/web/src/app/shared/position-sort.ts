/**
 * Orders rows by their `numeric(20,10)` position, which the API serialises as a string. Ties are left
 * to the caller: most lists have unique positions, and the few that do not add their own tie-breaker.
 */
export function byPosition(a: { position: string }, b: { position: string }): number {
  return Number(a.position) - Number(b.position);
}
