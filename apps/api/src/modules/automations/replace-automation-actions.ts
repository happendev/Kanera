import type { dto } from "@kanera/shared";
import { automations } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { recordActivity } from "../../lib/activity.js";
import { loadAutomation } from "../../lib/automations.js";
import { replaceActions, validateActionTargets } from "./route-support.js";

/** Replaces an automation's whole action list (`PUT /automations/:id/actions`). */
export async function replaceAutomationActions({
  auth,
  automation: current,
  body,
}: {
  auth: AuthClaims;
  automation: typeof automations.$inferSelect;
  body: dto.SetAutomationActionsBody;
}) {
  const id = current.id;
  await validateActionTargets(current.workspaceId, body.actions);
  await db.transaction(async (tx) => {
    await replaceActions(tx, id, body.actions);
    await tx
      .update(automations)
      .set({
        // Removing the final Do action must also disable the automation so it
        // cannot keep matching triggers with an empty effect set.
        ...(body.actions.length === 0 && { enabled: false }),
        updatedAt: new Date(),
      })
      .where(eq(automations.id, id));
    await recordActivity(tx, {
      boardId: null,
      workspaceId: current.workspaceId,
      actorId: auth.sub,
      entityType: "workspace",
      entityId: current.workspaceId,
      action: "automation:updated",
      payload: { automationId: id, actions: body.actions.length },
    });
  });
  const automation = await loadAutomation(id);
  return automation!;
}
