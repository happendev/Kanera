import { clientMembers, users, workspaces, type BoardMirror } from "@kanera/shared/schema";
import { and, eq, isNull } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";

export async function mirrorActor(mirror: BoardMirror): Promise<AuthClaims> {
  const [actor] = await db
    .select({ userId: users.id, clientId: clientMembers.clientId, role: clientMembers.clientRole })
    .from(users)
    .innerJoin(workspaces, eq(workspaces.id, mirror.sourceWorkspaceId))
    .innerJoin(clientMembers, and(
      eq(clientMembers.clientId, workspaces.clientId),
      eq(clientMembers.userId, users.id),
    ))
    .where(and(
      eq(users.id, mirror.createdById),
      isNull(users.deletedAt),
      isNull(clientMembers.suspendedAt),
      isNull(clientMembers.removedAt),
    ))
    .limit(1);
  if (!actor) throw new Error("board mirror creator is no longer an active user");
  return {
    sub: actor.userId,
    cid: actor.clientId,
    role: actor.role,
    authKind: "apiKey",
    apiKeyName: "Board mirror",
  };
}
