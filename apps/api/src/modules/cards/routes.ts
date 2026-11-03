import type { FastifyInstance } from "fastify";
import { cardQueryRoutes } from "./query.routes.js";
import { cardCreateRoutes } from "./create.routes.js";
import { cardUpdateRoutes } from "./update.routes.js";
import { cardBulkRoutes } from "./bulk.routes.js";
import { cardMoveRoutes } from "./move.routes.js";
import { cardCustomFieldRoutes } from "./custom-fields.routes.js";
import { cardChecklistRoutes } from "./checklists.routes.js";
import { cardChecklistItemRoutes } from "./checklist-items.routes.js";
import { cardRelationRoutes } from "./relations.routes.js";

export async function cardRoutes(
  app: FastifyInstance,
  options: { allowGlobalWorkLayoutMoves?: boolean } = {},
) {
  app.addHook("preHandler", app.authenticate);

  cardQueryRoutes(app);
  cardCreateRoutes(app, options);
  cardUpdateRoutes(app);
  cardBulkRoutes(app);
  cardMoveRoutes(app, options);
  cardCustomFieldRoutes(app);
  cardChecklistRoutes(app);
  cardChecklistItemRoutes(app);
  cardRelationRoutes(app);
}
