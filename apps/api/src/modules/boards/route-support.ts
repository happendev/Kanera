import { boardGroups } from "@kanera/shared/schema";
import { and, eq } from "drizzle-orm";
import { db } from "../../db.js";
import type { assertBoardAccess } from "../../lib/access.js";
import { badRequest } from "../../lib/errors.js";

export type BoardAccessContext = Awaited<ReturnType<typeof assertBoardAccess>>;

export async function validateBoardGroup(workspaceId: string, groupId: string | null | undefined) {
  if (groupId === undefined || groupId === null) return groupId ?? null;
  const [group] = await db
    .select({ id: boardGroups.id })
    .from(boardGroups)
    .where(and(eq(boardGroups.id, groupId), eq(boardGroups.workspaceId, workspaceId)))
    .limit(1);
  if (!group) throw badRequest("board group not found");
  return groupId;
}
