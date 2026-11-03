import type { LateStartCard, ScheduleAttentionCard, ScheduleAttentionResponse } from "@kanera/shared/dto";
import { boards, cardAssignees, cards, users } from "@kanera/shared/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { loadAccessibleBoards } from "../../lib/accessible-boards.js";
import { loadLateStarts, localToday } from "../../lib/late-starts.js";
import { loadViewerBoardSchedules } from "../../lib/schedule-graph.js";
import { absoluteCardUrl } from "../../lib/wire-card.js";

/**
 * The connected user's own open cards the schedule engine flags, board by board. Only direct
 * assignments count (a checklist item does not put a card on your plate for scheduling), and each
 * board is scheduled as the Timeline view shows it, so what the briefing says matches the chart.
 * Blockers are named only when they were loaded, which is only when the viewer can open them.
 */
export async function scheduleAttention(auth: AuthClaims, limit: number, timeZone?: string): Promise<ScheduleAttentionResponse> {
  const accessible = await loadAccessibleBoards(auth);
  const boardById = new Map(accessible.map((board) => [board.id, board]));
  if (accessible.length === 0) return { conflicts: [], critical: [], lateToStart: [], truncated: false };
  const assigned = await db.select({ id: cards.id, boardId: cards.boardId })
    .from(cards)
    .innerJoin(cardAssignees, eq(cardAssignees.cardId, cards.id))
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .where(and(
      eq(cardAssignees.userId, auth.sub),
      inArray(cards.boardId, accessible.map((board) => board.id)),
      isNull(cards.completedAt),
      isNull(cards.archivedAt),
      isNull(boards.archivedAt),
    ));
  const byBoard = new Map<string, string[]>();
  for (const row of assigned) byBoard.set(row.boardId, [...(byBoard.get(row.boardId) ?? []), row.id]);
  // Sidebar order, so the briefing walks boards the way the person does.
  const boardIds = [...byBoard.keys()].sort((a, b) => (boardById.get(a)?.navigationOrder ?? 0) - (boardById.get(b)?.navigationOrder ?? 0));
  const truncated = false;

  type Flagged = { id: string; boardId: string; verdict: NonNullable<ReturnType<Awaited<ReturnType<typeof loadViewerBoardSchedules>>["schedule"]["cards"]["get"]>> };
  const flagged: Flagged[] = [];
  const { schedule } = await loadViewerBoardSchedules(auth, boardIds);
  for (const boardId of boardIds) {
    for (const id of byBoard.get(boardId) ?? []) {
      const verdict = schedule.cards.get(id);
      if (verdict && (verdict.conflicts.length > 0 || verdict.critical)) flagged.push({ id, boardId, verdict });
    }
  }
  const nameIds = [...new Set(flagged.flatMap((entry) => [entry.id, ...entry.verdict.conflicts.map((conflict) => conflict.blockerId)]))];
  const named = new Map((nameIds.length
    ? await db.select({ id: cards.id, key: cards.key, title: cards.title, listId: cards.listId, organisationKey: cards.organisationKey }).from(cards).where(inArray(cards.id, nameIds))
    : []).map((row) => [row.id, row]));
  const toCard = (entry: Flagged): ScheduleAttentionCard | null => {
    const card = named.get(entry.id);
    if (!card) return null;
    return {
      id: card.id, key: card.key, title: card.title, url: absoluteCardUrl(card.organisationKey, card.key),
      boardId: entry.boardId, boardName: boardById.get(entry.boardId)?.name ?? "", listId: card.listId,
      plannedStart: entry.verdict.plannedStart, plannedEnd: entry.verdict.plannedEnd, slackDays: entry.verdict.slackDays, critical: entry.verdict.critical,
      conflicts: entry.verdict.conflicts.flatMap((conflict) => {
        const blocker = named.get(conflict.blockerId);
        return blocker ? [{ blockerId: blocker.id, blockerKey: blocker.key, blockerTitle: blocker.title, days: conflict.days }] : [];
      }),
    };
  };
  const byDate = (a: string | null, b: string | null) => (a ?? "9999").localeCompare(b ?? "9999");
  const conflicts = flagged.filter((entry) => entry.verdict.conflicts.length > 0)
    .sort((a, b) => byDate(a.verdict.plannedStart, b.verdict.plannedStart) || a.id.localeCompare(b.id))
    .map(toCard).filter((card): card is ScheduleAttentionCard => card !== null).slice(0, limit);
  const critical = flagged.filter((entry) => entry.verdict.conflicts.length === 0 && entry.verdict.critical)
    .sort((a, b) => byDate(a.verdict.plannedEnd, b.verdict.plannedEnd) || a.id.localeCompare(b.id))
    .map(toCard).filter((card): card is ScheduleAttentionCard => card !== null).slice(0, limit);
  const [viewer] = timeZone ? [{ timezone: timeZone }] : await db.select({ timezone: users.timezone }).from(users).where(eq(users.id, auth.sub)).limit(1);
  const now = new Date();
  const lateToStart = (await loadLateStarts(db, { userIds: [auth.sub], todayFor: () => localToday(now, viewer?.timezone), now }))
    .filter((row) => boardById.has(row.boardId))
    .slice(0, limit)
    .map((row): LateStartCard => ({
      id: row.id, key: row.key, title: row.title, url: absoluteCardUrl(row.organisationKey, row.key),
      boardId: row.boardId, boardName: boardById.get(row.boardId)?.name ?? row.boardName, listId: row.listId,
      startDate: row.startDateLocalDate!, dueDate: row.dueDateLocalDate,
    }));
  return { conflicts, critical, lateToStart, truncated };
}
