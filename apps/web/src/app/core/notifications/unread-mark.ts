/**
 * Shared vocabulary for the per-card unread mark, so a card wears the same badge wherever you meet
 * it — board tile, table row, or any future view. Two rules live here rather than in each template:
 *
 * - A single unread notification is a bare dot. The count only earns its digits once there is more
 *   than one, otherwise every marked card carries a redundant "1".
 * - Counts clamp at 9+. The mark sits inline before a card title in views that are already tight on
 *   width, and three digits would push the title around.
 */
const MAX_SHOWN = 9;

/** Text inside the mark: empty for a single unread (renders as a dot), then "2".."9+". */
export function unreadMarkText(count: number): string {
  if (count <= 1) return "";
  return count > MAX_SHOWN ? `${MAX_SHOWN}+` : String(count);
}

/** Accessible name and tooltip for the mark. Always spells out the real count, clamp included. */
export function unreadMarkLabel(count: number): string {
  return `${count} unread notification${count === 1 ? "" : "s"}`;
}
