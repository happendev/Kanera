import { SERVER_EVENTS, type WireAgentRun } from "@kanera/shared/events";
import { ACTIVITY_ACTION, agentRuns, AGENT_RUN_LIVE_STATUSES, type AgentRun } from "@kanera/shared/schema";
import { and, inArray, lt } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { db } from "../db.js";
import { emitToBoard } from "../realtime/emit.js";
import { emitActivityFeedItem, recordActivity } from "./activity.js";
import { startSweepScheduler } from "./sweep-scheduler.js";

// A live run that has not heartbeated for this long is presumed dead. Agents doing long work
// should PATCH the run (even with an empty body) well inside this window.
export const AGENT_RUN_STALL_AFTER_MS = 15 * 60 * 1000;
const STALL_SWEEP_INTERVAL_MS = 60 * 1000;

export function toWireAgentRun(run: AgentRun): WireAgentRun {
  return run;
}

/** Card-scoped activity for a run transition. `recordActivity` derives the actor kind from request context. */
export async function recordAgentRunActivity(run: AgentRun, action: typeof ACTIVITY_ACTION.AGENT_RUN_STARTED | typeof ACTIVITY_ACTION.AGENT_RUN_ENDED, options?: { actorKind?: "system" }) {
  const activity = await recordActivity(db, {
    boardId: run.boardId,
    workspaceId: run.workspaceId,
    actorId: run.userId,
    entityType: "card",
    entityId: run.cardId,
    action,
    payload: {
      runId: run.id,
      title: run.title,
      status: run.status,
      agentName: run.agentName,
      externalUrl: run.externalUrl,
      summary: run.summary,
    },
    ...(options?.actorKind ? { actorKind: options.actorKind } : {}),
  });
  await emitActivityFeedItem(run.boardId, run.cardId, activity);
  return activity;
}

/**
 * Marks live runs whose heartbeat lapsed as `stalled`, so a crashed agent cannot leave a card
 * showing "working" indefinitely. Emits the same `agentRun:updated` event an agent would, so
 * clients converge without special handling. Recorded as system activity: nobody acted, the
 * absence of action is what happened.
 */
export async function sweepStalledAgentRuns(log?: FastifyBaseLogger, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - AGENT_RUN_STALL_AFTER_MS);
  const stalled = await db
    .update(agentRuns)
    .set({ status: "stalled", updatedAt: now })
    .where(and(inArray(agentRuns.status, [...AGENT_RUN_LIVE_STATUSES]), lt(agentRuns.heartbeatAt, cutoff)))
    .returning();
  for (const run of stalled) {
    await recordAgentRunActivity(run, ACTIVITY_ACTION.AGENT_RUN_ENDED, { actorKind: "system" });
    await emitToBoard(run.boardId, SERVER_EVENTS.AGENT_RUN_UPDATED, { boardId: run.boardId, cardId: run.cardId, run: toWireAgentRun(run) });
  }
  if (stalled.length > 0) log?.info({ count: stalled.length }, "marked stalled agent runs");
  return stalled.length;
}

export function startAgentRunStallScheduler(log?: FastifyBaseLogger): () => Promise<void> {
  const sweep = startSweepScheduler({
    name: "agent-run-stall",
    task: () => sweepStalledAgentRuns(log),
    nextDelayMs: STALL_SWEEP_INTERVAL_MS,
    log,
  });
  return () => sweep.stop();
}
