/**
 * How strongly a queue-rank pill leans on the accent: 1 at rank #1, fading to 0 by rank 5.
 *
 * The head of the queue is what "Up next" means, so the first few ranks each step down a visible
 * shade and everything deeper shares the resting tint — a ramp spread over the whole 50-entry
 * queue would leave adjacent ranks indistinguishable. Consumed as the `--rank-heat` custom
 * property by shared/_rank-pill.scss, the same pattern as the portfolio table's heat cells.
 */
export function priorityRankHeat(rank: number): number {
  return Math.max(0, (5 - rank) / 4);
}
