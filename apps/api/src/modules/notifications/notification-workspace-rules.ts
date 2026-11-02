import { dto } from "@kanera/shared";
import type { NotificationWorkspaceRule } from "@kanera/shared/dto";
import { userNotificationWorkspaceRules } from "@kanera/shared/schema";
import { and, eq } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { loadAccessibleBoards } from "../../lib/accessible-boards.js";
import { notFound } from "../../lib/errors.js";
import { workspaceRuleMatrixValues } from "./notification-rules.js";

export async function putNotificationWorkspaceRule({ auth, workspaceId, body }: { auth: AuthClaims; workspaceId: string; body: dto.PutNotificationWorkspaceRuleBody }) {
  const canAccessWorkspace = (await loadAccessibleBoards(auth)).some((board) => board.workspaceId === workspaceId);
  if (!canAccessWorkspace) throw notFound("workspace not found");

  const rule = await db.transaction(async (tx) => {
    await tx
      .insert(userNotificationWorkspaceRules)
      .values({
        userId: auth.sub,
        workspaceId,
        paused: body.paused,
        ...workspaceRuleMatrixValues(body.types),
      })
      .onConflictDoUpdate({
        target: [userNotificationWorkspaceRules.userId, userNotificationWorkspaceRules.workspaceId],
        set: {
          paused: body.paused,
          ...workspaceRuleMatrixValues(body.types),
          updatedAt: new Date(),
        },
      });
    return {
      workspaceId,
      paused: body.paused,
      types: body.types,
    } satisfies NotificationWorkspaceRule;
  });
  return dto.notificationWorkspaceRule.parse(rule);
}

export async function deleteNotificationWorkspaceRule({ auth, workspaceId }: { auth: AuthClaims; workspaceId: string }): Promise<void> {
  const canAccessWorkspace = (await loadAccessibleBoards(auth)).some((board) => board.workspaceId === workspaceId);
  if (!canAccessWorkspace) throw notFound("workspace not found");
  await db
    .delete(userNotificationWorkspaceRules)
    .where(and(
      eq(userNotificationWorkspaceRules.userId, auth.sub),
      eq(userNotificationWorkspaceRules.workspaceId, workspaceId),
    ));
}
