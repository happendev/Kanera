import type { CardRelationSummary } from "@kanera/shared/dto";
import type { WireCard, WireCardSummary } from "@kanera/shared/events";
import type { Card } from "@kanera/shared/schema";
import { icu } from "../../core/i18n/icu";

/**
 * Open blockers for any card shape the board holds. Full card rows (from detail or a `card:updated`
 * that carried no count) have no count of their own; board state keeps the summary's value for them.
 */
export function blockedByCountOf(card: Card | WireCard | WireCardSummary): number {
  return "blockedByCount" in card ? card.blockedByCount : 0;
}

/**
 * Accessible name and tooltip for a card's Blocked chip, or null when the chip should not show: done
 * work (completed or archived) is not waiting on anything, whatever its relations say.
 */
export function blockedChipLabel(card: Card | WireCard | WireCardSummary): string | null {
  if (card.completedAt || card.archivedAt) return null;
  const count = blockedByCountOf(card);
  if (!count) return null;
  return icu($localize`:Tooltip on a card's Blocked chip:{count, plural, one {Blocked by 1 open card} other {Blocked by # open cards}}`, { count });
}

/**
 * Blockers still holding this card back: visible ones that are neither completed nor archived, plus
 * those on boards the viewer cannot open (the server only sends their count).
 */
function activeBlockerCount(relations: readonly CardRelationSummary[], hiddenBlockerCount: number): number {
  const open = relations.filter((relation) => relation.direction === "blocked_by" && !relation.card.completedAt && !relation.card.archivedAt).length;
  return open + hiddenBlockerCount;
}

/**
 * "Blocked by 2 active cards" while any blocker is active (hidden ones included), "No active blockers"
 * once every visible one is closed, null when the card has no blockers at all.
 */
export function blockerStatus(relations: readonly CardRelationSummary[], hiddenBlockerCount: number): { blocked: boolean; title: string } | null {
  const open = activeBlockerCount(relations, hiddenBlockerCount);
  if (open > 0) return { blocked: true, title: activeBlockersLabel(open) };
  if (relations.some((relation) => relation.direction === "blocked_by")) return { blocked: false, title: $localize`:Card detail status when every blocker is completed or archived:No active blockers` };
  return null;
}

function activeBlockersLabel(count: number): string {
  return icu($localize`:Card detail status line - this card cannot start until its open blockers are completed or archived:{count, plural, one {Blocked by 1 active card} other {Blocked by # active cards}}`, { count });
}

export function hiddenBlockersLabel(count: number): string {
  return icu($localize`:Card detail note about blockers on boards the viewer cannot open:{count, plural, one {Blocked by 1 card you can't access} other {Blocked by # cards you can't access}}`, { count });
}
