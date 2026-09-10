import { dto } from "@kanera/shared";
import { SERVER_EVENTS } from "@kanera/shared/events";
import { ACTIVITY_ACTION, agentRuns, cards, type AgentRun } from "@kanera/shared/schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { assertBoardAccess, assertCardAccess } from "../../lib/access.js";
import { recordAgentRunActivity, toWireAgentRun } from "../../lib/agent-runs.js";
import { conflict, notFound } from "../../lib/errors.js";
import { emitToBoard } from "../../realtime/emit.js";

const LIVE_STATUSES = ["running", "blocked"] as const;

/**
 * Who is this run attributed to? Interactive OAuth agents carry a grant + client name; workspace
 * and personal API keys fall back to the key name (or a generic label) so every run has a readable
 * agentName without the UI resolving credentials. A plain browser session may also start a run
 * (e.g. a person tracking a manual hand-off), which is labelled from the session.
 */
function runAgentIdentity(auth: { authKind?: string; apiKeyName?: string; agentGrantId?: string; agentName?: string }) {
  if (auth.agentGrantId) return { agentGrantId: auth.agentGrantId, agentName: auth.agentName ?? "AI agent" };
  if (auth.authKind === "apiKey") return { agentGrantId: null, agentName: auth.apiKeyName ?? "API client" };
  return { agentGrantId: null, agentName: "Manual run" };
}

export async function agentRunRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // Live runs for every card on a board: the board page fetches this once at open and then keeps it
  // current from agentRun:* events. Kept off the board-open payload so boards without agents pay
  // nothing extra on their hot path.
  app.get("/boards/:boardId/agent-runs", async (req) => {
    const { boardId } = req.params as { boardId: string };
    await assertBoardAccess(req.auth, boardId);
    const rows = await db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.boardId, boardId), inArray(agentRuns.status, [...LIVE_STATUSES])))
      .orderBy(desc(agentRuns.startedAt))
      .limit(500);
    return { runs: rows.map(toWireAgentRun) };
  });

  app.get("/cards/:cardId/agent-runs", async (req) => {
    const { cardId } = req.params as { cardId: string };
    const query = dto.listAgentRunsQuery.parse(req.query);
    await assertCardAccess(req.auth, cardId);
    const rows = await db
      .select()
      .from(agentRuns)
      .where(and(
        eq(agentRuns.cardId, cardId),
        query.includeEnded ? undefined : inArray(agentRuns.status, [...LIVE_STATUSES]),
      ))
      .orderBy(desc(agentRuns.startedAt))
      .limit(query.limit);
    return { runs: rows.map(toWireAgentRun) };
  });

  app.post("/cards/:cardId/agent-runs", async (req, reply) => {
    const { cardId } = req.params as { cardId: string };
    const body = dto.startAgentRunBody.parse(req.body);
    const [card] = await db.select({ id: cards.id, boardId: cards.boardId }).from(cards).where(eq(cards.id, cardId)).limit(1);
    if (!card) throw notFound("card not found");
    const ctx = await assertCardAccess(req.auth, card, "editor");
    const identity = runAgentIdentity(req.auth);
    const [run] = await db.insert(agentRuns).values({
      workspaceId: ctx.workspaceId,
      boardId: card.boardId,
      cardId,
      userId: req.auth.sub,
      agentGrantId: identity.agentGrantId,
      agentName: identity.agentName,
      title: body.title,
      summary: body.summary ?? null,
      externalUrl: body.externalUrl ?? null,
    }).returning();
    await recordAgentRunActivity(run!, ACTIVITY_ACTION.AGENT_RUN_STARTED);
    await emitToBoard(card.boardId, SERVER_EVENTS.AGENT_RUN_STARTED, { boardId: card.boardId, cardId, run: toWireAgentRun(run!) });
    return reply.status(201).send(toWireAgentRun(run!));
  });

  app.get("/agent-runs/:runId", async (req) => {
    const { runId } = req.params as { runId: string };
    const run = await loadRun(runId);
    await assertCardAccess(req.auth, { id: run.cardId, boardId: run.boardId });
    return toWireAgentRun(run);
  });

  app.patch("/agent-runs/:runId", async (req) => {
    const { runId } = req.params as { runId: string };
    const body = dto.updateAgentRunBody.parse(req.body);
    const existing = await loadRun(runId);
    await assertCardAccess(req.auth, { id: existing.cardId, boardId: existing.boardId }, "editor");
    // Ended runs are immutable history. Stalled runs are not ended: the agent may come back and
    // close them properly (or resume by setting status back to running).
    if (dto.isTerminalAgentRunStatus(existing.status)) throw conflict("agent run has already ended");

    const now = new Date();
    const nextStatus = body.status ?? existing.status;
    const ends = dto.isTerminalAgentRunStatus(nextStatus);
    const [run] = await db.update(agentRuns).set({
      status: nextStatus,
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.summary !== undefined ? { summary: body.summary } : {}),
      ...(body.externalUrl !== undefined ? { externalUrl: body.externalUrl } : {}),
      // Every update is a heartbeat, including a bare {} keep-alive.
      heartbeatAt: now,
      endedAt: ends ? now : null,
      updatedAt: now,
    }).where(eq(agentRuns.id, runId)).returning();
    if (ends) await recordAgentRunActivity(run!, ACTIVITY_ACTION.AGENT_RUN_ENDED);
    await emitToBoard(run!.boardId, SERVER_EVENTS.AGENT_RUN_UPDATED, { boardId: run!.boardId, cardId: run!.cardId, run: toWireAgentRun(run!) });
    return toWireAgentRun(run!);
  });
}

async function loadRun(runId: string): Promise<AgentRun> {
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
  if (!run) throw notFound("agent run not found");
  return run;
}
