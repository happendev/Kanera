import { dto } from "@kanera/shared";
import type { FastifyInstance } from "fastify";
import { assertCardActive } from "../../lib/card-guards.js";
import { badRequest } from "../../lib/errors.js";
import { toWireCard } from "../../lib/wire-card.js";
import { assertCardMoveTarget, emitCardMoved, moveCard } from "./move-card.js";
import { authorizeCardMoveToBoard, emitCardMovedToBoard, moveCardToBoard } from "./move-card-to-board.js";
import { loadEditableCard } from "./route-support.js";

/**
 * Card moves within a board and across boards. Called from `cardRoutes` rather than registered on
 * its own, so these routes share its `app.authenticate` preHandler.
 */
export function cardMoveRoutes(app: FastifyInstance, options: { allowGlobalWorkLayoutMoves?: boolean }) {
  app.post("/cards/:id/move", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.moveCardBody.parse(req.body);
    if (body.globalWorkUserId && !options.allowGlobalWorkLayoutMoves) {
      // Public integrations operate on real board lanes only. The personal Global Work anchor mode
      // is enabled solely by the first-party app server that also owns its separator routes.
      throw badRequest("Global Work layout anchors are not available through this API");
    }

    const { card: current, ctx } = await loadEditableCard(req.auth, id);
    assertCardActive(current);
    await assertCardMoveTarget({ auth: req.auth, cardId: id, ctx, body });

    const result = await moveCard({ auth: req.auth, card: current, ctx, body });

    // An idempotent no-op emits nothing; see `moveCard`.
    if (!result.noOp) await emitCardMoved({ auth: req.auth, result });
    return result.response;
  });

  app.post("/cards/:id/move-to-board", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.moveCardToBoardBody.parse(req.body);

    const { source, dstCtx, targetListId } = await authorizeCardMoveToBoard({ auth: req.auth, cardId: id, body });

    const result = await moveCardToBoard({ auth: req.auth, source, dstCtx, targetListId, body });

    await emitCardMovedToBoard({ auth: req.auth, result });
    // Replay the move then its automation effects above; the HTTP response represents the final
    // state so optimistic callers cannot overwrite those effects with the intermediate card.
    return toWireCard(result.finalCard, req.auth.cid);
  });
}
