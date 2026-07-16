import { users, type BoardMirror } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";

export async function mirrorActor(mirror: BoardMirror): Promise<AuthClaims> {
  const [actor] = await db
    .select({ userId: users.id, clientId: users.clientId, role: users.clientRole })
    .from(users)
    .where(eq(users.id, mirror.createdById))
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
