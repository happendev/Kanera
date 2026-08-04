/**
 * Shared vocabulary for the per-card unread mark, so a card wears the same badge wherever you meet
 * it — board tile, table row, or any future view.
 *
 * The mark is always a bare dot, never a count: it sits inline before a card title in views that are
 * already tight on width, and there it only has to answer "is there something new here?". The real
 * number is one click away in the drawer, which is where a card's updates are actually read, so the
 * count lives in the accessible name and tooltip rather than in the mark itself.
 */

/** Accessible name and tooltip for the mark, since the dot itself carries no number. */
export function unreadMarkLabel(count: number): string {
  return `${count} unread notification${count === 1 ? "" : "s"}`;
}
