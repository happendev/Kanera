import { automations } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { recordActivity } from "../../lib/activity.js";

/** Archives an automation and records the activity. */
export async function deleteAutomation({
  auth,
  automation: current,
}: {
  auth: AuthClaims;
  automation: typeof automations.$inferSelect;
}): Promise<void> {
  const id = current.id;
  await db.update(automations).set({ archivedAt: new Date(), updatedAt: new Date() }).where(eq(automations.id, id));
  await recordActivity(db, {
    boardId: null,
    workspaceId: current.workspaceId,
    actorId: auth.sub,
    entityType: "workspace",
    entityId: current.workspaceId,
    action: "automation:deleted",
    payload: { automationId: id },
  });
}
