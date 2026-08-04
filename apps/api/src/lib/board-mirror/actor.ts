import { workspaces, type BoardMirror } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";

export async function mirrorActor(mirror: BoardMirror): Promise<AuthClaims> {
  const [target] = await db
    .select({ clientId: workspaces.clientId })
    .from(workspaces)
    .where(eq(workspaces.id, mirror.targetWorkspaceId))
    .limit(1);
  if (!target) throw new Error("board mirror target workspace no longer exists");
  return {
    // The creator is durable attribution, not a service credential. The target workspace owns all
    // copied rows and storage, so later guest/workspace/organisation removal must not strand a
    // board-owned sync or accidentally charge the source tenant.
    sub: mirror.createdById,
    cid: target.clientId,
    role: "admin",
    authKind: "apiKey",
    apiKeyName: "Board mirror",
  };
}
