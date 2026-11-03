import { ACTIVITY_ACTION, automationInProgressRuns, boards, cardInProgressAlerts, cards, clients, workspaces } from "@kanera/shared/schema";
import { eq, sql } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import type { assertCardAccess } from "../../lib/access.js";
import { recordActivity } from "../../lib/activity.js";
import { notFound } from "../../lib/errors.js";
import { featureDisabledError } from "../../lib/workspace-features.js";

type CardAccessContext = Awaited<ReturnType<typeof assertCardAccess>>;

/**
 * Writes a workspace admin's correction of a card's tracked time in progress (see the route for the
 * product rules). Only the clock columns are written, so the card trigger does not fire.
 */
export async function setCardInProgressTime({ auth, card: current, ctx, seconds }: {
  auth: AuthClaims;
  card: typeof cards.$inferSelect;
  ctx: CardAccessContext;
  seconds: number;
}) {
  const id = current.id;
  return db.transaction(async (tx) => {
    const [locked] = await tx.select({ boardId: cards.boardId }).from(cards).where(eq(cards.id, id)).for("update");
    if (!locked) throw notFound();
    const [progress] = await tx.select({ enabled: sql<boolean>`${boards.inProgressEnabled} and ${workspaces.inProgressEnabled} and ${clients.inProgressEnabled}` })
      .from(boards).innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
      .innerJoin(clients, eq(clients.id, workspaces.clientId)).where(eq(boards.id, locked.boardId));
    if (!progress?.enabled) throw featureDisabledError("inProgress");
    const [clock] = await tx.execute<{ banked: number; running: number; alertDays: number }>(sql`
      select c.in_progress_seconds as banked, w.in_progress_alert_days as "alertDays",
             in_progress_working_seconds(c.in_progress_since, now(), w.time_zone) as running
      from card c
      inner join workspace w on w.id = c.workspace_id
      where c.id = ${id}
      for update of c
    `).then((result) => result.rows);
    if (!clock) throw notFound();
    const running = Number(clock.running);
    const fromSeconds = Number(clock.banked) + running;
    // Only an explicit reduction below the enabled alert rearms it, never a move or settings edit.
    const rearmAlert = seconds < fromSeconds && clock.alertDays > 0 && seconds < clock.alertDays * 86400;
    const keepsStint = seconds >= running && !rearmAlert;
    if (rearmAlert) {
      await tx.delete(cardInProgressAlerts).where(eq(cardInProgressAlerts.cardId, id));
      await tx.delete(automationInProgressRuns).where(eq(automationInProgressRuns.cardId, id));
    }
    const [updated] = await tx
      .update(cards)
      .set({
        inProgressSeconds: keepsStint ? seconds - running : seconds,
        ...(keepsStint ? {} : { inProgressSince: sql`case when ${cards.inProgressSince} is null then null else now() end` }),
        updatedAt: new Date(),
      })
      .where(eq(cards.id, id))
      .returning();
    const recorded = await recordActivity(tx, {
      boardId: current.boardId,
      workspaceId: ctx.workspaceId,
      actorId: auth.sub,
      entityType: "card",
      entityId: id,
      action: ACTIVITY_ACTION.IN_PROGRESS_TIME_SET,
      payload: { fromSeconds, toSeconds: seconds, rearmAlert },
    });
    return { card: updated!, activity: recorded };
  });
}
