import { conditionalCardResponse } from "../../lib/conditional-card-response.js";
import { dto } from "@kanera/shared";
import { cards } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { assertBoardAccess, assertCardAccess } from "../../lib/access.js";
import { AppError, notFound } from "../../lib/errors.js";
import { resolveCardKey } from "../../lib/card-keys.js";
import { repairInternalLinksAroundCard } from "../../lib/internal-links.js";
import { absoluteCardUrl } from "../../lib/wire-card.js";
import { loadCardDetail, queryCardContent } from "./card-queries.js";

/**
 * Card reads: lookup by key, the detail payload, and bulk content queries. Called from `cardRoutes`
 * rather than registered on its own, so these routes share its `app.authenticate` preHandler.
 */
export function cardQueryRoutes(app: FastifyInstance) {
  app.get("/organisations/:organisationKey/cards/by-key/:key", async (req) => {
    const { organisationKey, key } = req.params as { organisationKey: string; key: string };
    const card = await resolveCardKey(db, organisationKey, key);
    if (!card) throw notFound();
    try {
      // resolveCardKey already returned the board id, so this needs no second card read.
      await assertCardAccess(req.auth, card);
    } catch (error) {
      // Key lookup is intentionally non-disclosing: callers cannot distinguish an inaccessible
      // card from an identity that was never allocated.
      if (error instanceof AppError && (error.statusCode === 403 || error.statusCode === 404)) throw notFound();
      throw error;
    }
    return { ...card, url: absoluteCardUrl(card.organisationKey, card.key) };
  });

  app.get("/cards/:id/detail", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [card] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
    if (!card) throw notFound();
    // The row is already in hand; passing it skips a redundant re-read of its board_id.
    const ctx = await assertCardAccess(req.auth, card);
    const detail = await loadCardDetail({ auth: req.auth, card, ctx });
    // Healing with the viewer's claims can reveal links the author could not record, but its
    // workspace-wide note scan must not block this read; the next open can consume the repair. It
    // starts only once this read's own queries are done so it never competes with them for the pool.
    // A repair that changes links is an ordinary write: it advances the card's revision and publishes
    // card:links:changed, so an open drawer re-reads its linked items rather than this response.
    void repairInternalLinksAroundCard(req.auth, id, ctx.workspaceId).catch((err: unknown) =>
      req.log.warn({ err, cardId: id }, "failed to repair internal links around card"),
    );
    return conditionalCardResponse(req, reply, detail);
  });

  app.post("/boards/:boardId/cards/content/query", async (req) => {
    const { boardId } = req.params as { boardId: string };
    const body = dto.selectedCardContentQueryBody.parse(req.body);
    const ctx = await assertBoardAccess(req.auth, boardId);
    return queryCardContent({ auth: req.auth, boardId, ctx, body });
  });
}
