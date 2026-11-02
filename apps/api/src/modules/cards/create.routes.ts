import { dto } from "@kanera/shared";
import { cards } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { assertBoardAccess, assertCardAccess } from "../../lib/access.js";
import { emitLaneRebalanced } from "../../lib/board-lane.js";
import { assertCardActive } from "../../lib/card-guards.js";
import { notFound } from "../../lib/errors.js";
import { toWireCard } from "../../lib/wire-card.js";
import type { WireCard } from "@kanera/shared/events";
import { createCard, emitCardCreate, prepareBulkCardCreate, prepareCardCreate } from "./create-card.js";
import { duplicateCard, duplicateCardForBulk, emitCardDuplicate } from "./duplicate-cards-bulk.js";
import { activeBulkCards, loadBulkBoardCards } from "./route-support.js";

type BoardAccessContext = Awaited<ReturnType<typeof assertBoardAccess>>;

/**
 * Card creation and duplication, single and bulk. Called from `cardRoutes` rather than registered
 * on its own, so these routes share its `app.authenticate` preHandler.
 */
export function cardCreateRoutes(app: FastifyInstance, options: { allowGlobalWorkLayoutMoves?: boolean }) {
  app.post("/boards/:boardId/lists/:id/cards", async (req, reply) => {
    const { boardId, id: listId } = req.params as { boardId: string; id: string };
    const body = dto.createCardBody.parse(req.body);
    const prepared = await prepareCardCreate({ auth: req.auth, boardId, listId, body, allowGlobalWorkLayoutMoves: options.allowGlobalWorkLayoutMoves });
    if (prepared.kind === "replayed") return reply.status(201).send(toWireCard(prepared.card, req.auth.cid));
    const result = await createCard({ auth: req.auth, plan: prepared.plan });
    return reply.status(201).send(await emitCardCreate({ auth: req.auth, mailer: app.mailer, result }));
  });

  app.post("/boards/:boardId/cards/bulk/create", async (req, reply) => {
    const { boardId } = req.params as { boardId: string };
    const body = dto.bulkCreateCardsBody.parse(req.body);
    const plans = await prepareBulkCardCreate({ auth: req.auth, boardId, body, allowGlobalWorkLayoutMoves: options.allowGlobalWorkLayoutMoves });
    // Each card commits on its own, like bulk duplicate: one card's automations and emits never
    // hold a transaction open across the batch. Validation above makes a mid-batch failure rare.
    const created: WireCard[] = [];
    for (const plan of plans) {
      const result = await createCard({ auth: req.auth, plan });
      created.push(await emitCardCreate({ auth: req.auth, mailer: app.mailer, result }));
    }
    return reply.status(201).send({ created: created.length, cards: created });
  });

  app.post("/boards/:boardId/cards/bulk/duplicate", async (req, reply) => {
    const { boardId } = req.params as { boardId: string };
    const body = dto.bulkDuplicateCardsBody.parse(req.body);
    const ctx = await assertBoardAccess(req.auth, boardId, "editor");
    const targetBoardId = body.boardId ?? boardId;
    const dstCtx = targetBoardId === boardId ? ctx : await assertBoardAccess(req.auth, targetBoardId, "editor");
    const loaded = await loadBulkBoardCards(boardId, body.cardIds, ctx.assignedItemsOnly ? req.auth.sub : undefined);
    const { cards: targetCards, skippedCardIds } = activeBulkCards(loaded);
    const created: WireCard[] = [];

    for (const source of targetCards) {
      const duplicated = await duplicateCardForBulk({ auth: req.auth, source, srcCtx: ctx, dstCtx, targetBoardId, listId: body.listId });
      created.push(await emitCardDuplicate({ auth: req.auth, boardId: targetBoardId, duplicated }));
    }

    return reply.status(201).send({ duplicated: created.length, cards: created, skippedCardIds });
  });

  app.post("/cards/:id/duplicate", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = dto.duplicateCardBody.parse(req.body ?? {});

    const [source] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
    if (!source) throw notFound();
    const srcCtx = await assertCardAccess(req.auth, source, "editor");
    assertCardActive(source);

    const targetBoardId = body.boardId ?? source.boardId;
    let dstCtx: BoardAccessContext = srcCtx;
    if (targetBoardId !== source.boardId) {
      dstCtx = await assertBoardAccess(req.auth, targetBoardId, "editor");
    }

    const { targetListId, duplicated, rebalancedPositions } = await duplicateCard({ auth: req.auth, source, srcCtx, dstCtx, body });

    if (rebalancedPositions) await emitLaneRebalanced(targetBoardId, targetListId, rebalancedPositions);
    const wireNewCard = await emitCardDuplicate({ auth: req.auth, boardId: targetBoardId, duplicated });

    return reply.status(201).send(wireNewCard);
  });
}
