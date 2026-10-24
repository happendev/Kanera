import { z } from "zod";
import type { ColorToken } from "../lib/colors.js";
import type { ScheduleConflict } from "../lib/schedule.js";

/**
 * POST /cards/schedule (also /api/v1 for API clients and agents): the Timeline view's schedule for a
 * board or a workspace, computed server-side by the same engine (`@kanera/shared/schedule`) so an
 * agent and the person looking at the chart never disagree about slack or the critical path.
 *
 * Open cards only; completed cards neither move nor hold anything up. Complete connected chains
 * are followed across boards through cards the viewer can open. Unreadable cards are left out
 * (their dependents simply have one blocker fewer), including when they would bridge two branches.
 */
export const scheduleBody = z.union([
  z.object({ boardId: z.uuid() }).strict(),
  z.object({ workspaceId: z.uuid() }).strict(),
]);
export type ScheduleBody = z.infer<typeof scheduleBody>;

/** One open card, with the engine's verdict beside the dates the card itself holds. */
export interface ScheduleCard {
  id: string;
  key: string;
  title: string;
  url: string;
  boardId: string;
  listId: string;
  labelIds: string[];
  assigneeIds: string[];
  /** The planned bar; null when the card has neither a start nor a due date. */
  plannedStart: string | null;
  plannedEnd: string | null;
  /** Working days (Mon–Fri) the bar covers, inclusive; a point is one day. */
  durationDays: number;
  earliestStart: string | null;
  earliestFinish: string | null;
  latestStart: string | null;
  latestFinish: string | null;
  /** Working days this card can slip without delaying the end of its chain; null when unanchored. */
  slackDays: number | null;
  /** On the critical path: chained to at least one other open card and without slack. */
  critical: boolean;
  /** Open blockers planned to finish on or after this card's planned start. */
  conflicts: ScheduleConflict[];
  blockerIds: string[];
  dependentIds: string[];
}

/** The engine's view of one whole scope, in the words a project manager uses. */
export interface ScheduleSummary {
  /** Open cards with at least one date. */
  scheduledCount: number;
  /** Open cards with neither date; they are listed but take no part in the schedule. */
  unscheduledCount: number;
  /** Open cards with at least one conflict. */
  conflictCount: number;
  criticalCount: number;
  /** Earliest planned start and latest planned or earliest finish over the open dated cards. */
  range: { start: string; end: string } | null;
  /**
   * When the critical chain is expected to finish: the latest earliest-finish over every critical
   * card, or over every dated card when nothing is chained. Null with no dated cards.
   */
  projectedFinish: string | null;
  /** The latest due date among the open dated cards: what the plan promised. */
  latestDue: string | null;
  /** Working days `projectedFinish` lands after `latestDue`; 0 when the plan still holds. */
  slipDays: number;
}

export interface ScheduleResponse {
  cards: ScheduleCard[];
  /** `blocks` edges between two cards in `cards`. */
  edges: { id: string; sourceCardId: string; targetCardId: string }[];
  criticalEdgeIds: string[];
  summary: ScheduleSummary;
  boards: { id: string; name: string; icon: string | null; iconColor: ColorToken | null }[];
  lists: { id: string; name: string }[];
  labels: { id: string; name: string; color: ColorToken | null }[];
  people: { userId: string; displayName: string; avatarUrl: string | null }[];
  /** Reserved for partial responses; complete schedules currently return false. */
  truncated: boolean;
}

/**
 * Schedule health for a board inside a portfolio rollup or a person's day: the counts a manager
 * scans before opening the chart.
 */
export interface ScheduleHealth {
  conflictCount: number;
  criticalCount: number;
  projectedFinish: string | null;
  latestDue: string | null;
  slipDays: number;
}

/**
 * POST /work/schedule-attention/query: the connected user's own open cards that the schedule engine
 * flags, for a morning briefing. Each board the user holds an assignment on is scheduled on its own,
 * as the Timeline view would show it.
 */
export const scheduleAttentionBody = z.object({
  limit: z.number().int().min(1).max(50).default(20).describe("Maximum cards per section."),
}).strict();
export type ScheduleAttentionBody = z.infer<typeof scheduleAttentionBody>;

export interface ScheduleAttentionCard {
  id: string;
  key: string;
  title: string;
  url: string;
  boardId: string;
  boardName: string;
  listId: string;
  plannedStart: string | null;
  plannedEnd: string | null;
  slackDays: number | null;
  critical: boolean;
  conflicts: { blockerId: string; blockerKey: string; blockerTitle: string; days: number }[];
}

export interface ScheduleAttentionResponse {
  /** Cards with at least one conflict, soonest planned start first. */
  conflicts: ScheduleAttentionCard[];
  /** Critical-path cards without a conflict, soonest planned end first. */
  critical: ScheduleAttentionCard[];
  /** Reserved for incomplete evaluations; section limits do not truncate the underlying schedule. */
  truncated: boolean;
}

/**
 * A boundary the schedule engine found when a board was rechecked against its last verdict, carried
 * on a `card:updated` outbox row for integrations. `days` is the worst conflict's working days for
 * `schedule.conflict_detected` and the working days the projected finish moved for
 * `schedule.critical_path_slipped`.
 */
export type ScheduleTransition =
  | { name: "schedule.conflict_detected"; blockerCardId: string; days: number }
  | { name: "schedule.conflict_resolved" }
  | { name: "schedule.critical_path_slipped"; previousProjectedFinish: string; projectedFinish: string; days: number; slipDays: number };
