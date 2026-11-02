import { dto } from "@kanera/shared";
import type { ScheduleAttentionResponse, WorkDoneSummaryResponse } from "@kanera/shared/dto";
import type { FastifyInstance } from "fastify";
import { applyWorkScope, loadAccessibleBoards } from "../../lib/accessible-boards.js";
import { loadWorkDoneSummary } from "../../lib/work-done.js";
import { agentWorkCards, agentWorkHistory } from "./agent-work.js";
import { portfolio } from "./portfolio.js";
import { createWorkView, deleteWorkView, shareWorkView, unshareWorkView, updateWorkView } from "./save-work-view.js";
import { loadSavedViews, loadShareCandidates } from "./saved-views.js";
import { scheduleAttention } from "./schedule-attention.js";
import { loadCatalog, queryWorkCardsForApp } from "./work-cards-query.js";
import { globalWorkDoneOptions, queryGlobalWorkDone } from "./work-done-query.js";

/**
 * Public/MCP-safe reporting projections. History accepts one visible actor so an agent can prepare
 * a cross-board review without enumerating every board; current-work remains as a compatibility
 * route for existing public clients while MCP v2 uses the generic card query.
 */
export async function agentWorkRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.post("/work/history/query", async (req) => agentWorkHistory(req.auth, req.body));

  // The schedule engine's briefing for the connected user; same handler on both servers.
  app.post("/work/schedule-attention/query", async (req): Promise<ScheduleAttentionResponse> => {
    const query = dto.scheduleAttentionBody.parse(req.body ?? {});
    return scheduleAttention(req.auth, query.limit, query.timeZone);
  });

  app.post("/me/work-history", async (req) => {
    const body = dto.agentWorkHistoryQueryBody.parse(req.body ?? {});
    return agentWorkHistory(req.auth, { ...body, userId: req.auth.sub });
  });

  app.post("/me/current-work", async (req) => {
    const query = dto.agentCurrentWorkQueryBody.parse(req.body ?? {});
    return agentWorkCards(req.auth, {
      lens: "my",
      scope: query.scope,
      filters: { q: query.q ?? "", completion: "active" },
      sort: "updatedDesc",
      cursor: query.cursor,
      limit: query.limit,
    });
  });
}

/**
 * Bounded cross-board projections for public agents. Keep this registration separate from
 * workRoutes: saved-view and layout administration remain app-only even though both surfaces share
 * the same access-filtered query implementation.
 */
export async function agentWorkQueryRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.post("/work/cards/query", async (req) => {
    return agentWorkCards(req.auth, req.body);
  });

  app.post("/work/portfolio/query", async (req) => {
    const accessibleBoards = await loadAccessibleBoards(req.auth);
    return portfolio(req.auth, accessibleBoards, req.body);
  });
}

export async function workRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/work/catalog", async (req) => {
    const startedAt = performance.now();
    const scope = dto.workScopeSchema.partial().parse(req.query);
    const normalized = dto.workScopeSchema.parse(scope);
    const accessibleBoards = await loadAccessibleBoards(req.auth);
    const boardsInScope = applyWorkScope(accessibleBoards, normalized);
    const catalog = await loadCatalog(boardsInScope, req.auth.cid);
    req.log.info({
      event: "work_catalog_loaded",
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
      boardCount: catalog.boards.length,
      accessFilteredSources: accessibleBoards.length - boardsInScope.length,
    });
    return catalog;
  });

  app.post("/work/cards/query", async (req) => {
    const startedAt = performance.now();
    const accessibleBoards = await loadAccessibleBoards(req.auth);
    try {
      const { result, lens, scopedCount } = await queryWorkCardsForApp({ auth: req.auth, accessibleBoards, body: req.body });
      req.log.info({
        event: "work_cards_queried",
        lens,
        durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
        resultCount: result.cards.length,
        checklistResultCount: result.checklistItems.length,
        total: result.totals.cards,
        hasNextCursor: Boolean(result.nextCursor),
        accessFilteredSources: accessibleBoards.length - scopedCount,
      });
      return result;
    } catch (error) {
      if ((req.body as { cursor?: unknown } | null)?.cursor) {
        req.log.warn({
          event: "work_cursor_failure",
          durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
        });
      }
      throw error;
    }
  });

  app.post("/work/work-done/query", async (req) => {
    const startedAt = performance.now();
    const query = dto.globalWorkDoneQueryBody.parse(req.body);
    const { events, boardCount, accessibleCount, scopedCount } = await queryGlobalWorkDone({ auth: req.auth, query });

    req.log.info({
      event: "work_done_queried",
      lens: query.lens,
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
      resultCount: events.length,
      boardCount,
      accessFilteredSources: accessibleCount - scopedCount,
    });
    return { events };
  });

  app.post("/work/work-done/summary/query", async (req) => {
    const query = dto.globalWorkDoneSummaryQueryBody.parse(req.body);
    const { options } = await globalWorkDoneOptions(req.auth, query);
    // The list/label narrowing the timeline applies in JS cannot be expressed on an aggregate, so
    // the strip reports the unnarrowed day totals for the same lens, scope and access boundary.
    const response: WorkDoneSummaryResponse = await loadWorkDoneSummary(options);
    return response;
  });


  app.get("/work-views/share-candidates", async (req) => loadShareCandidates(req.auth.cid));

  app.get("/work-views", async (req) => {
    const result = await loadSavedViews(req.auth);
    req.log.info({ event: "work_saved_views_loaded", resultCount: result.length });
    return result;
  });

  app.post("/work-views", async (req, reply) => {
    const body = dto.createWorkViewBody.parse(req.body);
    const shaped = await createWorkView({ auth: req.auth, body });
    req.log.info({ event: "work_saved_view_created", lens: body.lens, visibility: body.visibility });
    return reply.status(201).send(shaped);
  });

  app.patch("/work-views/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.updateWorkViewBody.parse(req.body);
    return updateWorkView({ auth: req.auth, id, body });
  });

  app.delete("/work-views/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await deleteWorkView({ auth: req.auth, id });
    return reply.status(204).send();
  });

  app.post("/work-views/:id/shares", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { userId } = dto.shareWorkViewBody.parse(req.body);
    await shareWorkView({ auth: req.auth, id, userId });
    return reply.status(204).send();
  });

  app.delete("/work-views/:id/shares/:userId", async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    await unshareWorkView({ auth: req.auth, id, userId });
    return reply.status(204).send();
  });
}
