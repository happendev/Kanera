import { dto } from "@kanera/shared";
import type { FastifyInstance } from "fastify";
import { assertCardActive } from "../../lib/card-guards.js";
import { loadEditableCard } from "./route-support.js";
import {
  clearCardCustomFieldValue,
  emitCardCustomFieldValueCleared,
  emitCardCustomFieldValueSet,
  setCardCustomFieldValue,
} from "./card-custom-field-values.js";

/**
 * Setting and clearing a card custom field value. Called from `cardRoutes` rather than registered
 * on its own, so these routes share its `app.authenticate` preHandler.
 */
export function cardCustomFieldRoutes(app: FastifyInstance) {
  app.put("/cards/:id/custom-fields/:fieldId", async (req) => {
    const { id, fieldId } = req.params as { id: string; fieldId: string };
    const body = dto.setCustomFieldValueBody.parse(req.body);
    const { card, ctx } = await loadEditableCard(req.auth, id);
    assertCardActive(card);
    const result = await setCardCustomFieldValue({ auth: req.auth, card, ctx, fieldId, body });
    if (result.changed) await emitCardCustomFieldValueSet(result);
    return result.value;
  });

  app.delete("/cards/:id/custom-fields/:fieldId", async (req, reply) => {
    const { id, fieldId } = req.params as { id: string; fieldId: string };
    const { card, ctx } = await loadEditableCard(req.auth, id);
    assertCardActive(card);
    const result = await clearCardCustomFieldValue({ auth: req.auth, card, ctx, fieldId });
    if (!result.cleared) return reply.code(204).send();
    await emitCardCustomFieldValueCleared(result);
    return reply.status(204).send();
  });
}
