import type { dto } from "@kanera/shared";
import { SERVER_EVENTS } from "@kanera/shared/events";
import { ACTIVITY_ACTION, cards, type ActivityEvent } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { env } from "../../env.js";
import type { assertCardAccess } from "../../lib/access.js";
import { recordActivity, recordCoalescedActivity, type CoalescedActivityResult } from "../../lib/activity.js";
import { enqueueDueDateChangedEmails } from "../../lib/assignee-email-notifications.js";
import { assertCardActive } from "../../lib/card-guards.js";
import { emitRelationNeighboursChanged, lockWorkspaceRelations } from "../../lib/card-relations.js";
import { resolveDueDatePatch, resolveStartDatePatch } from "../../lib/due-date.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { EMPTY_LINK_FANOUT, emitInternalLinksChanged, linkNeighbours, mergeLinkFanout, replaceInternalLinksForSource, type LinkFanout } from "../../lib/internal-links.js";
import type { Mailer } from "../../lib/mailer.js";
import { stripSignedEmbeddedMediaUrls } from "../../lib/media-keys.js";
import { replaceCardMentions } from "../../lib/mentions.js";
import { requestScheduleRecheckForCards } from "../../lib/schedule-events.js";
import { toWireCard } from "../../lib/wire-card.js";
import { emitToBoard } from "../../realtime/emit.js";
import { actorTimezone, emitCardActivityFeedItem, emitCoalescedCardActivityFeedItem } from "./route-support.js";

type CardAccessContext = Awaited<ReturnType<typeof assertCardAccess>>;
type CardRow = typeof cards.$inferSelect;

type UpdatedCard = {
  card: CardRow;
  previous: CardRow;
  /** Null when the patch matched the locked row: nothing was written and nothing is emitted. */
  activity: ActivityEvent | CoalescedActivityResult | null;
  linkFanout: LinkFanout;
  hasDueDateUpdate: boolean;
  renamed: boolean;
  workspaceId: string;
};

/**
 * Title, description and date writes for one card. The caller has already loaded the card for
 * editing, rejected archived cards and checked the timeline feature and embedded media.
 */
export async function updateCard({ auth, card: loaded, ctx, body }: {
  auth: AuthClaims;
  card: CardRow;
  ctx: CardAccessContext;
  body: dto.UpdateCardBody;
}): Promise<UpdatedCard> {
  const id = loaded.id;
  const description = body.description === undefined
    ? undefined
    : stripSignedEmbeddedMediaUrls(body.description, auth.cid);
  const hasDueDateUpdate = body.dueDateLocalDate !== undefined || body.dueDateSlot !== undefined;
  const timezone = hasDueDateUpdate ? await actorTimezone(auth.sub) : "UTC";
  const { card, previous: current, activity, linkFanout } = await db.transaction(async (tx) => {
    // Match the worker's graph-before-card lock order. Validate against the locked row: another
    // editor may have moved either date since access was checked, including a bulk/automation edit.
    await lockWorkspaceRelations(tx, ctx.workspaceId);
    const [current] = await tx.select().from(cards).where(eq(cards.id, id)).for("update");
    if (!current || current.boardId !== loaded.boardId) throw notFound();
    assertCardActive(current);
    // Slot-only patches keep the locked stored date and timezone (see resolveDueDatePatch).
    const dueDatePatch = hasDueDateUpdate
      ? resolveDueDatePatch(body, current, timezone)
      : { kind: "unchanged" as const };
    if (dueDatePatch.kind === "rejected") throw badRequest(dueDatePatch.reason);
    const dueDateLocalDate = dueDatePatch.kind === "write" ? dueDatePatch.dueDateLocalDate : undefined;
    const dueDateSlot = dueDatePatch.kind === "write" ? dueDatePatch.dueDateSlot : undefined;
    const dueDateTimezone = dueDatePatch.kind === "write" ? dueDatePatch.dueDateTimezone : undefined;
    // A start may never sit after the due date (see resolveStartDatePatch): an explicit later start
    // is the caller's error, while a due date moved before the stored start drags the start with it
    // so a Timeline bar can never be drawn backwards. Clearing the due date leaves the start alone.
    const startDatePatch = resolveStartDatePatch(
      body,
      current,
      dueDatePatch.kind === "write" ? dueDatePatch.dueDateLocalDate : current.dueDateLocalDate,
    );
    if (startDatePatch.kind === "rejected") throw badRequest(startDatePatch.reason);
    const startDateLocalDate = startDatePatch.kind === "write" ? startDatePatch.startDateLocalDate : undefined;
    const titleChanged = body.title !== undefined && body.title !== current.title;
    const descriptionChanged = description !== undefined && (description ?? "") !== (current.description ?? "");
    const dueDateChanged = dueDateLocalDate !== undefined && (
      dueDateLocalDate !== current.dueDateLocalDate || dueDateSlot !== current.dueDateSlot || dueDateTimezone !== current.dueDateTimezone
    );
    const startDateChanged = startDateLocalDate !== undefined && startDateLocalDate !== current.startDateLocalDate;
    // Explicit Save and API retries can submit the current value. Only real changes belong in
    // activity bursts; a no-op also leaves timestamps, mentions and realtime untouched.
    if (!titleChanged && !descriptionChanged && !dueDateChanged && !startDateChanged) {
      return { card: current, previous: current, activity: null, linkFanout: EMPTY_LINK_FANOUT };
    }

    const activityPayload = {
      ...(titleChanged && { title: body.title }),
      ...(descriptionChanged && { description }),
      ...(descriptionChanged && {
        // Description history is audit-facing: keep the raw markdown before and
        // after the edit so clients can show an exact diff for any update shape.
        fromValue: current.description,
        toValue: description,
      }),
      ...(dueDateChanged && {
        dueDateLocalDate,
        dueDateSlot,
        dueDateTimezone,
      }),
      // A clamped start was not in the body, yet it did change; the history must say so. A drag on
      // the Timeline sends both dates and lands here as one "rescheduled" row, not two.
      ...(startDateChanged && { startDateLocalDate }),
    };
    // Description saves and card renames are often repeated while someone is drafting.
    // Keep each field in its own burst so mixed edits and date history stay precise.
    const isDescriptionOnlyUpdate = descriptionChanged && !titleChanged && !dueDateChanged && !startDateChanged;
    const isTitleOnlyUpdate = titleChanged && !descriptionChanged && !dueDateChanged && !startDateChanged;
    const [card] = await tx
      .update(cards)
      .set({
        ...(titleChanged && { title: body.title }),
        ...(descriptionChanged && { description }),
        ...(dueDateLocalDate !== undefined && { dueDateLocalDate }),
        ...(dueDateSlot !== undefined && { dueDateSlot }),
        ...(dueDateTimezone !== undefined && { dueDateTimezone }),
        ...(startDateLocalDate !== undefined && { startDateLocalDate }),
        updatedAt: new Date(),
      })
      .where(eq(cards.id, id))
      .returning();
    // Only a moved bar can change the schedule; a title or description edit never does.
    if (dueDateLocalDate !== undefined || startDateLocalDate !== undefined) await requestScheduleRecheckForCards(tx, [id]);

    let linkFanout: LinkFanout = EMPTY_LINK_FANOUT;
    if (descriptionChanged) {
      await replaceCardMentions({
        tx,
        boardId: current.boardId,
        cardId: id,
        source: "description",
        markdown: description,
      });
      linkFanout = await replaceInternalLinksForSource({
        tx,
        claims: auth,
        workspaceId: ctx.workspaceId,
        sourceType: "card",
        sourceId: id,
        markdown: description,
      });
    }

    const activityInput = {
      boardId: current.boardId,
      workspaceId: ctx.workspaceId,
      actorId: auth.sub,
      entityType: "card",
      entityId: id,
      action: ACTIVITY_ACTION.UPDATED,
      payload: activityPayload,
    } as const;
    const activity = isDescriptionOnlyUpdate
      ? await recordCoalescedActivity(tx, {
        ...activityInput,
        coalesceKey: "card:description",
        windowMs: 120_000,
        fromValue: current.description,
        toValue: description,
      })
      : isTitleOnlyUpdate
        ? await recordCoalescedActivity(tx, {
          ...activityInput,
          coalesceKey: "card:title",
          windowMs: 120_000,
          fromValue: current.title,
          toValue: body.title,
        })
      : await recordActivity(tx, activityInput);
    return { card: card!, previous: current, activity, linkFanout };
  });
  const renamed = body.title !== undefined && body.title !== current.title;
  return { card, previous: current, activity, linkFanout, hasDueDateUpdate, renamed, workspaceId: ctx.workspaceId };
}

/** Post-commit fanout for `updateCard`; returns the wire card the route responds with. */
export async function emitUpdatedCard(
  { card, previous: current, activity, linkFanout, hasDueDateUpdate, renamed, workspaceId }: UpdatedCard,
  { auth, mailer }: { auth: AuthClaims; mailer: Mailer },
) {
  if (!activity) return toWireCard(card, auth.cid);
  const id = card.id;
  if (hasDueDateUpdate || card.startDateLocalDate !== current.startDateLocalDate) {
    await enqueueDueDateChangedEmails({
      tx: db,
      mailer,
      webOrigin: env.WEB_ORIGIN,
      cardId: id,
      actorId: auth.sub,
      previousDue: {
        dueDateLocalDate: current.dueDateLocalDate,
        dueDateSlot: current.dueDateSlot,
        dueDateTimezone: current.dueDateTimezone,
      },
      nextDue: {
        dueDateLocalDate: card.dueDateLocalDate,
        dueDateSlot: card.dueDateSlot,
        dueDateTimezone: card.dueDateTimezone,
      },
      previousStart: current.startDateLocalDate,
      nextStart: card.startDateLocalDate,
    });
  }
  const wireCard = toWireCard(card, auth.cid);
  await emitToBoard(current.boardId, SERVER_EVENTS.CARD_UPDATED, { boardId: current.boardId, card: wireCard });
  if ("status" in activity) await emitCoalescedCardActivityFeedItem(current.boardId, id, activity);
  else await emitCardActivityFeedItem(current.boardId, id, activity);
  // Covers both ends: this card's own linked items and everything it started or stopped linking.
  // A rename also reaches every card and note already linked either way, since they show this
  // card's title in their linked items, backlinks and link chips.
  await emitInternalLinksChanged(renamed
    ? mergeLinkFanout(linkFanout, await linkNeighbours(workspaceId, "card", id))
    : linkFanout);
  if (renamed) await emitRelationNeighboursChanged([id]);
  return wireCard;
}
