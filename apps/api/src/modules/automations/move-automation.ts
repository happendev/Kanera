import type { dto } from "@kanera/shared";
import { automations } from "@kanera/shared/schema";
import type { AuthClaims } from "../../auth/plugin.js";
import { moveOrderedEntity } from "../../lib/move-ordered-entity.js";
import { workspaceNeighbourPositions } from "../../lib/position.js";
import { rebalanceAutomations } from "../../lib/rebalance.js";

// Reorder requests only need the anchor and its immediate neighbor. Keep this
// as targeted indexed probes so large workspaces do not pay for a full automation scan.
const neighbourPositions = workspaceNeighbourPositions(automations, "Automation");

/** Reorders an automation within its workspace; the route emits from the returned positions. */
export async function moveAutomation({
  auth,
  automation: current,
  body,
}: {
  auth: AuthClaims;
  automation: typeof automations.$inferSelect;
  body: dto.MoveAutomationBody;
}) {
  const id = current.id;
  const prevPosition = current.position;
  const { position, rebalancedPositions } = await moveOrderedEntity({
    table: automations,
    idColumn: automations.id,
    id,
    neighbours: await neighbourPositions(current.workspaceId, body.afterAutomationId, body.beforeAutomationId),
    rebalance: (tx) => rebalanceAutomations(current.workspaceId, tx),
    activity: (position) => ({
      boardId: null,
      workspaceId: current.workspaceId,
      actorId: auth.sub,
      entityType: "workspace",
      entityId: current.workspaceId,
      action: "moved",
      payload: { automationId: id, prevPosition, position },
    }),
  });
  return { position, prevPosition, rebalancedPositions };
}
