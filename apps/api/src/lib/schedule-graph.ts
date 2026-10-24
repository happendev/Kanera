import type { ScheduleBody, ScheduleCard, ScheduleHealth, ScheduleResponse, ScheduleSummary } from "@kanera/shared/dto";
import { computeSchedule, dayNumber, workingDaysBetween, type Schedule, type ScheduleEdgeInput, type ScheduledCard } from "@kanera/shared/schedule";
import { boards, cardLabels, cardRelations, cards, lists, users } from "@kanera/shared/schema";
import { and, eq, exists, inArray, isNull, or, type SQL } from "drizzle-orm";
import type { AuthClaims } from "../auth/plugin.js";
import { db, type Tx } from "../db.js";
import { featureDisabledError, loadWorkspaceFeatures } from "./workspace-features.js";
import { assignedCardVisibility, assertBoardAccess } from "./access.js";
import { loadWorkCardSummaries, toWireCardSummary } from "./card-summary.js";
import { loadAccessibleBoards } from "./accessible-boards.js";
import { signedAvatarUrl } from "./media-keys.js";
import { absoluteCardUrl } from "./wire-card.js";

export type ScheduleCardRow = {
  id: string;
  boardId: string;
  startDateLocalDate: string | null;
  dueDateLocalDate: string | null;
};

const scheduleCardRef = { id: cards.id, boardId: cards.boardId, startDateLocalDate: cards.startDateLocalDate, dueDateLocalDate: cards.dueDateLocalDate };

/** Open cards only: a completed card neither moves nor holds anything up, and archived cards are off the board. */
const openCard = and(isNull(cards.completedAt), isNull(cards.archivedAt));

export interface ScheduleScope {
  /** Cards in the requested scope, then every connected open card that the viewer may open. */
  cards: ScheduleCardRow[];
  /** Ids of the cards the request scoped, as opposed to the ones a chain pulled in. */
  inScope: Set<string>;
  edges: ScheduleEdgeInput[];
  truncated: boolean;
}

/** Read the graph in two bounded-query batches, then walk complete connected components in memory.
 * Both directions matter: an off-board successor sets the chain finish used by the backward pass.
 * Access is applied before the walk, so an unreadable card is never a bridge to another component.
 * A display limit must never become a scheduling limit or a persisted worker verdict.
 */
async function collectScheduleScope(
  database: Tx,
  seedBoardIds: readonly string[],
  workspaceIds: readonly string[],
  visibility?: SQL,
  // Workspaces whose dependencies are switched off schedule each card on its own dates: their
  // `blocks` rows are kept but neither chain cards together nor pull in neighbours.
  dependencyWorkspaceIds: readonly string[] = workspaceIds,
): Promise<ScheduleScope> {
  if (!seedBoardIds.length || !workspaceIds.length) return { cards: [], edges: [], inScope: new Set(), truncated: false };
  const chained = dependencyWorkspaceIds.length
    ? or(inArray(cards.boardId, [...seedBoardIds]), and(inArray(cards.workspaceId, [...dependencyWorkspaceIds]), exists(database.select({ id: cardRelations.id }).from(cardRelations)
      .where(and(eq(cardRelations.kind, "blocks"), or(eq(cardRelations.sourceCardId, cards.id), eq(cardRelations.targetCardId, cards.id)))))))
    : inArray(cards.boardId, [...seedBoardIds]);
  const allCards = await database.select(scheduleCardRef).from(cards)
    .where(and(inArray(cards.workspaceId, [...workspaceIds]), openCard, visibility, chained))
    .orderBy(cards.createdAt, cards.id);
  const byId = new Map(allCards.map((card) => [card.id, card]));
  const allEdges = dependencyWorkspaceIds.length
    ? await database.select({ id: cardRelations.id, sourceCardId: cardRelations.sourceCardId, targetCardId: cardRelations.targetCardId })
      .from(cardRelations)
      .where(and(eq(cardRelations.kind, "blocks"), inArray(cardRelations.workspaceId, [...dependencyWorkspaceIds])))
    : [];
  const adjacency = new Map<string, string[]>();
  const readableEdges = allEdges.filter((edge) => byId.has(edge.sourceCardId) && byId.has(edge.targetCardId));
  for (const edge of readableEdges) {
    for (const [from, to] of [[edge.sourceCardId, edge.targetCardId], [edge.targetCardId, edge.sourceCardId]] as const) {
      const neighbours = adjacency.get(from) ?? [];
      neighbours.push(to);
      adjacency.set(from, neighbours);
    }
  }
  const seedBoards = new Set(seedBoardIds);
  const inScope = new Set(allCards.filter((card) => seedBoards.has(card.boardId)).map((card) => card.id));
  const reached = new Set(inScope);
  const queue = [...reached];
  for (const current of queue) {
    for (const id of adjacency.get(current) ?? []) {
      if (reached.has(id)) continue;
      reached.add(id);
      queue.push(id);
    }
  }
  return {
    cards: queue.map((id) => byId.get(id)!), inScope,
    edges: readableEdges.filter((edge) => reached.has(edge.sourceCardId)).sort((a, b) => a.id.localeCompare(b.id)),
    truncated: false,
  };
}

/** Runs the engine over a collected scope. Every loaded card is open, so none is `done`. */
export function scheduleOf(scope: ScheduleScope): Schedule {
  return computeSchedule(scope.cards.map((card) => ({ ...card, done: false })), scope.edges);
}

/**
 * The scope's verdict in a project manager's words. `projectedFinish` is the latest earliest-finish
 * over the critical cards, or over every dated card when nothing is chained; `latestDue` is the
 * latest planned end, what the plan promised; `slipDays` is how many working days the first lands
 * after the second (0 when the plan still holds).
 */
export function summarizeSchedule(schedule: Schedule, cardIds: Iterable<string>): ScheduleSummary {
  let scheduledCount = 0;
  let unscheduledCount = 0;
  let conflictCount = 0;
  let criticalCount = 0;
  let criticalFinish: string | null = null;
  let datedFinish: string | null = null;
  let latestDue: string | null = null;
  for (const id of cardIds) {
    const card = schedule.cards.get(id);
    if (!card) continue;
    const dated = card.plannedStart !== null || card.plannedEnd !== null;
    if (dated) scheduledCount += 1;
    else unscheduledCount += 1;
    if (card.conflicts.length) conflictCount += 1;
    if (card.critical) {
      criticalCount += 1;
      if (card.earliestFinish && (!criticalFinish || card.earliestFinish > criticalFinish)) criticalFinish = card.earliestFinish;
    }
    if (dated && card.earliestFinish && (!datedFinish || card.earliestFinish > datedFinish)) datedFinish = card.earliestFinish;
    if (card.plannedEnd && (!latestDue || card.plannedEnd > latestDue)) latestDue = card.plannedEnd;
  }
  const projectedFinish = criticalFinish ?? datedFinish;
  const slipDays = projectedFinish && latestDue && projectedFinish > latestDue
    ? workingDaysBetween(dayNumber(latestDue) + 1, dayNumber(projectedFinish))
    : 0;
  return { scheduledCount, unscheduledCount, conflictCount, criticalCount, range: schedule.range, projectedFinish, latestDue, slipDays };
}

/** The engine's per-card verdict in the wire shape, minus the card's own identity fields. */
function scheduleVerdict(card: ScheduledCard): Pick<ScheduleCard, "plannedStart" | "plannedEnd" | "durationDays" | "earliestStart" | "earliestFinish" | "latestStart" | "latestFinish" | "slackDays" | "critical" | "conflicts" | "blockerIds" | "dependentIds"> {
  return {
    plannedStart: card.plannedStart,
    plannedEnd: card.plannedEnd,
    durationDays: card.durationDays,
    earliestStart: card.earliestStart,
    earliestFinish: card.earliestFinish,
    latestStart: card.latestStart,
    latestFinish: card.latestFinish,
    slackDays: card.slackDays,
    critical: card.critical,
    conflicts: card.conflicts,
    blockerIds: card.blockerIds,
    dependentIds: card.dependentIds,
  };
}

/**
 * The open cards of one board as the schedule engine sees them, with no viewer: the worker's view
 * when it rechecks a board for `schedule.*` events, where every card the chain touches counts.
 */
export async function loadBoardScheduleScope(database: Tx, boardId: string): Promise<ScheduleScope> {
  const [board] = await database.select({ workspaceId: boards.workspaceId }).from(boards).where(eq(boards.id, boardId));
  if (!board) return collectScheduleScope(database, [], []);
  const features = await loadWorkspaceFeatures(board.workspaceId, database);
  if (!features.timeline) return collectScheduleScope(database, [], []);
  return collectScheduleScope(database, [boardId], [board.workspaceId], undefined, features.dependencies ? [board.workspaceId] : []);
}

/**
 * The schedule for one scope as this viewer may see it. A board the viewer cannot open is refused
 * like every other board read; a workspace scope silently yields only the boards the viewer is on
 * (board guests read workspace boards without being workspace members, and an unknown workspace is
 * indistinguishable from one with no readable cards).
 */
export async function loadSchedule(claims: AuthClaims, scope: ScheduleBody): Promise<ScheduleResponse> {
  const viewer = await loadViewerSchedule(claims, scope);
  return renderSchedule(claims, viewer.scope, viewer.schedule);
}

/** The collected scope and the engine's verdict for this viewer, before any wire shaping. */
async function loadViewerSchedule(claims: AuthClaims, scope: ScheduleBody): Promise<{ scope: ScheduleScope; schedule: Schedule }> {
  if ("boardId" in scope) await assertBoardAccess(claims, scope.boardId);
  const accessible = await loadAccessibleBoards(claims);
  const seedBoards = accessible.filter((board) => "boardId" in scope ? board.id === scope.boardId : board.workspaceId === scope.workspaceId);
  // Refused only once the caller has shown it can read the scope, so the error reveals nothing an
  // empty schedule would not; a workspace's boards share its features, so one board answers.
  if (seedBoards.length > 0 && !seedBoards[0]!.timelineEnabled) throw featureDisabledError("timeline");
  return loadViewerBoardSchedules(claims, seedBoards.map((board) => board.id));
}

/** One authorization load and one graph for an entire portfolio, regardless of board count. */
export async function loadViewerBoardSchedules(claims: AuthClaims, boardIds: readonly string[]): Promise<{ scope: ScheduleScope; schedule: Schedule }> {
  const accessible = await loadAccessibleBoards(claims);
  const requested = new Set(boardIds);
  // Boards whose workspace has the timeline switched off have no schedule to report.
  const seeds = accessible.filter((board) => requested.has(board.id) && board.timelineEnabled);
  const workspaceIds = [...new Set(seeds.map((board) => board.workspaceId))];
  const dependencyWorkspaceIds = [...new Set(seeds.filter((board) => board.dependenciesEnabled).map((board) => board.workspaceId))];
  const workspaces = new Set(workspaceIds);
  const neighbours = accessible.filter((board) => workspaces.has(board.workspaceId));
  const full = neighbours.filter((board) => !board.assignedItemsOnly).map((board) => board.id);
  const restricted = neighbours.filter((board) => board.assignedItemsOnly).map((board) => board.id);
  const visibility = or(inArray(cards.boardId, full), and(inArray(cards.boardId, restricted), assignedCardVisibility(claims.sub)));
  const scope = await collectScheduleScope(db, seeds.map((board) => board.id), workspaceIds, visibility, dependencyWorkspaceIds);
  return { scope, schedule: scheduleOf(scope) };
}

export function scheduleHealthOf(summary: ScheduleSummary): ScheduleHealth {
  return { conflictCount: summary.conflictCount, criticalCount: summary.criticalCount, projectedFinish: summary.projectedFinish, latestDue: summary.latestDue, slipDays: summary.slipDays };
}

/** Builds the wire response: the engine's verdict beside each card's identity and the lookups it references. */
async function renderSchedule(claims: AuthClaims, scope: ScheduleScope, schedule: Schedule): Promise<ScheduleResponse> {
  const ids = scope.cards.map((card) => card.id);
  const summaries = ids.length ? await loadWorkCardSummaries(ids) : [];
  const scheduleCards: ScheduleCard[] = summaries.flatMap((row) => {
    const verdict = schedule.cards.get(row.id);
    if (!verdict) return [];
    const summary = toWireCardSummary(row, claims.cid, new Set());
    return [{
      id: summary.id,
      key: summary.key,
      title: summary.title,
      url: absoluteCardUrl(summary.organisationKey, summary.key),
      boardId: summary.boardId,
      listId: summary.listId,
      labelIds: summary.labelIds ?? [],
      assigneeIds: summary.assigneeIds ?? [],
      ...scheduleVerdict(verdict),
    }];
  });
  // Oldest first, like the seeds, so the chart's rows do not reshuffle between identical reads.
  const order = new Map(ids.map((id, index) => [id, index]));
  scheduleCards.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const lookups = await scheduleLookups(scheduleCards);
  return {
    cards: scheduleCards,
    edges: scope.edges,
    criticalEdgeIds: [...schedule.criticalEdgeIds].sort(),
    summary: summarizeSchedule(schedule, ids),
    ...lookups,
    truncated: scope.truncated,
  };
}

async function scheduleLookups(scheduleCards: readonly ScheduleCard[]): Promise<Pick<ScheduleResponse, "boards" | "lists" | "labels" | "people">> {
  const boardIds = [...new Set(scheduleCards.map((card) => card.boardId))];
  const listIds = [...new Set(scheduleCards.map((card) => card.listId))];
  const labelIds = [...new Set(scheduleCards.flatMap((card) => card.labelIds))];
  const userIds = [...new Set(scheduleCards.flatMap((card) => card.assigneeIds))];
  const [boardRows, listRows, labelRows, userRows] = await Promise.all([
    boardIds.length ? db.select({ id: boards.id, name: boards.name, icon: boards.icon, iconColor: boards.iconColor }).from(boards).where(inArray(boards.id, boardIds)) : [],
    listIds.length ? db.select({ id: lists.id, name: lists.name }).from(lists).where(inArray(lists.id, listIds)) : [],
    labelIds.length ? db.select({ id: cardLabels.id, name: cardLabels.name, color: cardLabels.color }).from(cardLabels).where(inArray(cardLabels.id, labelIds)) : [],
    userIds.length ? db.select({ userId: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl, clientId: users.clientId }).from(users).where(inArray(users.id, userIds)) : [],
  ]);
  return {
    boards: boardRows,
    lists: listRows,
    labels: labelRows,
    // Only assignees of cards the viewer can open get here, so naming them leaks nothing the cards don't.
    people: userRows.map(({ clientId, avatarUrl, ...user }) => ({ ...user, avatarUrl: signedAvatarUrl(clientId, avatarUrl) })),
  };
}
