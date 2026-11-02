import type { dto } from "@kanera/shared";
import { type WireCard, SERVER_EVENTS } from "@kanera/shared/events";
import { ACTIVITY_ACTION, cardAssignees, cardCustomFieldValues, cardLabelAssignments, cardLabels, cards, cardWatchers, customFields, externalLinks, lists } from "@kanera/shared/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { assertBoardAccess } from "../../lib/access.js";
import { recordActivity } from "../../lib/activity.js";
import { evaluateWorkspaceAnalyticsMilestones } from "../../lib/analytics-milestones.js";
import { enqueueCardAssignedEmails } from "../../lib/assignee-email-notifications.js";
import { emitAutomationEffects, runCardAssignedAutomations, runCardLabelSetAutomations, runCustomFieldValueChangedAutomations, runListEntryAutomations, type AutomationEffects } from "../../lib/automations.js";
import { emitLaneRebalanced, emitWorkspaceLaneRebalanced, positionForLaneInsert, rebalanceBoardLane } from "../../lib/board-lane.js";
import { ensureBoardMembershipForUsers, shouldAutoWatchAuthoredCards } from "../../lib/card-assignment.js";
import { assertIntegrationEmbeddedMediaStoredLocally } from "../../lib/card-guards.js";
import { allocateCardKeys } from "../../lib/card-keys.js";
import { lockWorkspaceRelations } from "../../lib/card-relations.js";
import { buildCustomFieldValueColumns, type CustomFieldValueColumns } from "../../lib/custom-fields.js";
import { AppError, badRequest, conflict, notFound } from "../../lib/errors.js";
import { assertExternalLinkWriteAccess, findExternalLink } from "../../lib/external-links.js";
import { emitInternalLinksChanged, replaceInternalLinksForSource } from "../../lib/internal-links.js";
import type { Mailer } from "../../lib/mailer.js";
import { stripSignedEmbeddedMediaUrls } from "../../lib/media-keys.js";
import { replaceCardMentions } from "../../lib/mentions.js";
import { requestScheduleRecheckForBoards } from "../../lib/schedule-events.js";
import { toWireCard } from "../../lib/wire-card.js";
import { assertWorkspaceFeature } from "../../lib/workspace-features.js";
import { emitToBoard } from "../../realtime/emit.js";
import { assertGlobalWorkSeparatorContext, positionForGlobalWorkLaneInsert } from "../global-work-separators/routes.js";
import { actorTimezone, emitCardActivityFeedItem } from "./route-support.js";

interface CardCreatePlan {
  boardId: string;
  listId: string;
  ctx: Awaited<ReturnType<typeof assertBoardAccess>>;
  body: dto.CreateCardBody;
  description: string | null;
  assigneeIds: string[];
  labelIds: string[];
  customFieldValues: Array<{ fieldId: string } & CustomFieldValueColumns>;
  dueDate: { dueDateLocalDate: string; dueDateSlot: dto.DueDateSlot; dueDateTimezone: string } | null;
  startDateLocalDate: string | null;
}

type PreparedCardCreate = { kind: "replayed"; card: typeof cards.$inferSelect } | { kind: "ready"; plan: CardCreatePlan };

/**
 * Every check a card create makes before writing. Bulk create runs this for the whole batch first,
 * so one bad label or assignee rejects the request before any card exists.
 */
export async function prepareCardCreate({
  auth,
  boardId,
  listId,
  body,
  allowGlobalWorkLayoutMoves,
}: {
  auth: AuthClaims;
  boardId: string;
  listId: string;
  body: dto.CreateCardBody;
  allowGlobalWorkLayoutMoves: boolean | undefined;
}): Promise<PreparedCardCreate> {
  const assigneeIds = Array.from(new Set(body.assigneeIds ?? []));
  const labelIds = Array.from(new Set(body.labelIds ?? []));

  const [list] = await db.select().from(lists).where(eq(lists.id, listId)).limit(1);
  if (!list) throw notFound();
  const ctx = await assertBoardAccess(auth, boardId, "editor");
  // Identity-wide personal credentials adopt the target organisation during access validation;
  // tenant-bound media handling must use that rebased context.
  assertIntegrationEmbeddedMediaStoredLocally(body.description, auth.cid, auth.authKind);
  const description = stripSignedEmbeddedMediaUrls(body.description ?? null, auth.cid);
  // Restricted editors must retain access to cards they create; make that grant atomic with the
  // card creation rather than relying on a follow-up client request.
  if (ctx.assignedItemsOnly && !assigneeIds.includes(auth.sub)) assigneeIds.push(auth.sub);
  if (list.workspaceId !== ctx.workspaceId) throw badRequest("target list not in board workspace");
  if (body.globalWorkUserId && !allowGlobalWorkLayoutMoves) {
    // Public integrations create against real board lanes only; see the same guard on move.
    throw badRequest("Global Work layout anchors are not available through this API");
  }
  if (body.globalWorkUserId) {
    await assertGlobalWorkSeparatorContext({
      auth,
      workspaceId: ctx.workspaceId,
      targetUserId: body.globalWorkUserId,
      listId,
    });
    // The card only appears in that person's lane if it is assigned to them, so an anchored
    // position there is meaningless otherwise.
    if (!assigneeIds.includes(body.globalWorkUserId)) throw badRequest("card must be assigned to the Global Work user");
  }

  if (body.clientToken) {
    const [existing] = await db.select().from(cards).where(eq(cards.clientToken, body.clientToken)).limit(1);
    if (existing) {
      if (existing.boardId !== boardId || existing.listId !== listId || existing.createdById !== auth.sub) {
        throw badRequest("client token was already used for another card create");
      }
      // At-least-once delivery can replay a create whose committed response was lost. Returning
      // the first result avoids duplicating activity, automations, emails, and realtime events.
      return { kind: "replayed", card: existing };
    }
  }

  if (assigneeIds.length > 0) {
    const eligibleUserIds = await ensureBoardMembershipForUsers(boardId, assigneeIds);
    if (eligibleUserIds.length !== assigneeIds.length) {
      throw badRequest("one or more user ids are not assignable members");
    }
  }
  if (labelIds.length > 0) {
    // Labels are workspace-scoped, so any active label of the board's workspace is valid here.
    const validLabels = await db
      .select({ id: cardLabels.id })
      .from(cardLabels)
      .where(and(eq(cardLabels.workspaceId, ctx.workspaceId), inArray(cardLabels.id, labelIds), isNull(cardLabels.archivedAt)));
    if (validLabels.length !== labelIds.length) throw badRequest("one or more label ids are invalid");
  }
  const customFieldValues: CardCreatePlan["customFieldValues"] = [];
  for (const [fieldId, input] of Object.entries(body.customFields ?? {})) {
    // Fields belong to the workspace shared by its boards, never to an individual board.
    const [field] = await db.select().from(customFields).where(and(
      eq(customFields.id, fieldId), eq(customFields.workspaceId, ctx.workspaceId), isNull(customFields.archivedAt),
    )).limit(1);
    if (!field) throw notFound("custom field not found");
    customFieldValues.push({ fieldId, ...await buildCustomFieldValueColumns(field, input, { workspaceId: ctx.workspaceId }) });
  }
  if (body.externalRef) {
    // Creation must not bypass the workspace-level policy for integration metadata.
    await assertExternalLinkWriteAccess(auth, ctx.workspaceId);
    const { provider, type, id } = body.externalRef;
    if (provider.startsWith("mirror:")) throw badRequest("the mirror provider namespace is reserved");
    if (await findExternalLink({ workspaceId: ctx.workspaceId, provider, externalType: type, externalId: id })) {
      throw conflict("external reference already exists");
    }
  }
  // A due date set at creation captures the creator's zone, exactly as a later PATCH would.
  const dueDate = body.dueDateLocalDate
    ? { dueDateLocalDate: body.dueDateLocalDate, dueDateSlot: body.dueDateSlot ?? "anyTime" as const, dueDateTimezone: await actorTimezone(auth.sub) }
    : null;
  // A start set at creation was already checked against the due date in the same body by the
  // DTO; a card has no stored due date yet, so there is nothing else it could be after.
  const startDateLocalDate = body.startDateLocalDate ?? null;
  if (startDateLocalDate) await assertWorkspaceFeature(ctx.workspaceId, "timeline");

  return { kind: "ready", plan: { boardId, listId, ctx, body, description, assigneeIds, labelIds, customFieldValues, dueDate, startDateLocalDate } };
}

/**
 * Prepares a bulk create item by item, so the whole batch is validated before any card exists.
 */
export async function prepareBulkCardCreate({
  auth,
  boardId,
  body,
  allowGlobalWorkLayoutMoves,
}: {
  auth: AuthClaims;
  boardId: string;
  body: dto.BulkCreateCardsBody;
  allowGlobalWorkLayoutMoves: boolean | undefined;
}): Promise<CardCreatePlan[]> {
  const plans: CardCreatePlan[] = [];
  const externalIdentities = new Set<string>();
  for (const [index, { listId, ...item }] of body.cards.entries()) {
    try {
      if (item.externalRef) {
        const identity = JSON.stringify([item.externalRef.provider, item.externalRef.type, item.externalRef.id]);
        if (externalIdentities.has(identity)) throw conflict("external reference already exists");
        externalIdentities.add(identity);
      }
      const prepared = await prepareCardCreate({ auth, boardId, listId, body: item, allowGlobalWorkLayoutMoves });
      // Bulk items carry no clientToken, so nothing can replay; the public API's Idempotency-Key
      // covers the whole batch instead.
      if (prepared.kind === "ready") plans.push(prepared.plan);
    } catch (error) {
      // Name the offending entry; "one or more label ids are invalid" alone is unactionable in a
      // batch of fifty.
      if (error instanceof AppError) throw new AppError(error.statusCode, error.code, `cards[${index}]: ${error.message}`, error.details);
      throw error;
    }
  }
  return plans;
}

type CommittedCardCreate = Awaited<ReturnType<typeof createCard>>;

export async function createCard({ auth, plan }: { auth: AuthClaims; plan: CardCreatePlan }) {
  const { boardId, listId, ctx, body, description, assigneeIds, labelIds, customFieldValues, dueDate, startDateLocalDate } = plan;
  return db.transaction(async (tx) => {
    // Graph lock first: automations below may complete or reopen a blocker, and every write that
    // touches the dependency graph takes this lock before any row, so lock order never inverts.
    await lockWorkspaceRelations(tx, ctx.workspaceId);
    if (body.clientToken) {
      // Serialize idempotent replays before touching the workspace counter. A concurrent retry
      // observes the committed identity and consumes no second number.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${body.clientToken}, 0))`);
      const [existing] = await tx.select().from(cards).where(eq(cards.clientToken, body.clientToken)).limit(1);
      if (existing) {
        if (existing.boardId !== boardId || existing.listId !== listId || existing.createdById !== auth.sub) {
          throw badRequest("client token was already used for another card create");
        }
        return { kind: "replayed", card: existing } as const;
      }
    }
    // Cards and separators share one numeric lane, so an anchored create resolves through the same
    // helper as separator creates and card moves. Edges (atTop / default bottom) are the null
    // anchor forms of the same helper.
    const anchor = body.afterItem !== undefined
      ? { afterItem: body.afterItem }
      : body.beforeItem !== undefined
        ? { beforeItem: body.beforeItem }
        : body.atTop
          ? { afterItem: null }
          : { beforeItem: null };
    // A Global Work insert settles any rebalance before the card exists, so it never needs the
    // board-lane rebalance below; its workspace-wide rebalance is emitted separately.
    const globalWorkPlacement = body.globalWorkUserId
      ? await positionForGlobalWorkLaneInsert({
          auth,
          workspaceId: ctx.workspaceId,
          targetUserId: body.globalWorkUserId,
          listId,
          ...anchor,
          tx,
        })
      : null;
    const positionResult = globalWorkPlacement
      ? { position: globalWorkPlacement.position, needsRebalance: false }
      : await positionForLaneInsert({ listId, boardId, ...anchor, tx });
    const laneRebalanced = globalWorkPlacement?.rebalanced ?? null;
    const position = positionResult.position;
    const [identity] = await allocateCardKeys(tx, ctx.workspaceId, 1);
    const [card] = await tx
      .insert(cards)
      .values({
        ...identity!,
        clientToken: body.clientToken ?? null,
        listId,
        boardId,
        title: body.title,
        description,
        ...dueDate,
        startDateLocalDate,
        position,
        createdById: auth.sub,
      })
      // The predicate matches the partial unique index. A concurrent retry waits for the first
      // insert and then takes the replay path below without repeating any create side effects.
      .onConflictDoNothing({
        target: cards.clientToken,
        where: sql`${cards.clientToken} is not null`,
      })
      .returning();

    if (!card) {
      // Every app/public-API writer takes the advisory lock above. Rolling back here also rolls
      // back the allocated counter range if an out-of-band writer races the client token.
      throw new Error("card create identity conflicted after allocation");
    }
    // A dated card is a new bar on the board's schedule; an undated one takes no part in it yet.
    if (card.dueDateLocalDate || card.startDateLocalDate) await requestScheduleRecheckForBoards(tx, [boardId]);

    if (assigneeIds.length > 0) {
      await tx.insert(cardAssignees).values(assigneeIds.map((userId) => ({ cardId: card.id, userId })));
    }
    if (labelIds.length > 0) {
      await tx.insert(cardLabelAssignments).values(labelIds.map((labelId) => ({ cardId: card.id, labelId })));
    }

    const createdFieldValues = customFieldValues.length > 0
      ? await tx.insert(cardCustomFieldValues).values(customFieldValues.map((value) => ({ cardId: card.id, ...value }))).returning()
      : [];
    if (body.externalRef) {
      const { provider, type, id } = body.externalRef;
      // Never repoint an existing external identity. A conflict rolls back the card and values
      // too, including when another writer claimed the identity after preparation.
      const [link] = await tx.insert(externalLinks).values({
        workspaceId: ctx.workspaceId, provider, externalType: type, externalId: id,
        entityType: "card", entityId: card.id,
      }).onConflictDoNothing().returning({ id: externalLinks.id });
      if (!link) throw conflict("external reference already exists");
    }

    await replaceCardMentions({
      tx,
      boardId,
      cardId: card.id,
      source: "description",
      markdown: description,
    });
    const linkFanout = await replaceInternalLinksForSource({
      tx,
      claims: auth,
      workspaceId: ctx.workspaceId,
      sourceType: "card",
      sourceId: card.id,
      markdown: description,
    });

    if (shouldAutoWatchAuthoredCards(auth)) {
      await tx
        .insert(cardWatchers)
        .values({ cardId: card.id, userId: auth.sub })
        .onConflictDoNothing();
    }

    const activity = await recordActivity(tx, {
      boardId,
      workspaceId: ctx.workspaceId,
      actorId: auth.sub,
      entityType: "card",
      entityId: card.id,
      action: ACTIVITY_ACTION.CREATED,
      payload: {
        title: card.title,
        listId,
        // Labels and due date set at creation belong to the creation event; the card's history
        // records no separate label or due-date change for them.
        ...(labelIds.length > 0 && { labelIds }),
        ...(customFieldValues.length > 0 && { customFields: body.customFields }),
        ...(body.externalRef && { externalRef: body.externalRef }),
        ...(dueDate && dueDate),
        ...(startDateLocalDate && { startDateLocalDate }),
      },
    });
    // Initial values participate in the same field-change rules as create-then-set. Store all
    // values first so every rule (including list-entry rules) sees the fully described card.
    const customFieldAutomationEffects: AutomationEffects = { effects: [] };
    for (const value of createdFieldValues) {
      const effects = await runCustomFieldValueChangedAutomations(tx, {
        cardId: card.id, fieldId: value.fieldId, previousValue: undefined, currentValue: value,
        boardId, workspaceId: ctx.workspaceId, clientId: ctx.clientId, triggerActorId: auth.sub,
      });
      customFieldAutomationEffects.effects.push(...effects.effects);
    }
    // App and public API card creation share this route; keep list-entry
    // automations here so both surfaces behave the same.
    const automationEffects = await runListEntryAutomations(tx, {
      cardId: card.id,
      listId,
      boardId,
      workspaceId: ctx.workspaceId,
      // Automation quota belongs to the board's owning organisation, never the caller's home org:
      // a cross-org guest's req.auth.cid would charge (and cap) the wrong tenant.
      clientId: ctx.clientId,
      trigger: "create",
      triggerActorId: auth.sub,
    });
    // Creating from Global Work assigns the card immediately, so assignment-triggered
    // automations and notifications need to see the same committed card as ordinary creation.
    const assignmentAutomationEffects: AutomationEffects = assigneeIds.length > 0
      ? await runCardAssignedAutomations(tx, {
          cardId: card.id,
          addedUserIds: assigneeIds,
          boardId,
          workspaceId: ctx.workspaceId,
          clientId: ctx.clientId,
          triggerActorId: auth.sub,
        })
      : { effects: [] };
    // Labels given at creation fire label-set rules exactly as create-then-label would, so an
    // integration that switches to the one-call form keeps the board's automations.
    const labelAutomationEffects: AutomationEffects = labelIds.length > 0
      ? await runCardLabelSetAutomations(tx, {
          cardId: card.id,
          addedLabelIds: labelIds,
          boardId,
          workspaceId: ctx.workspaceId,
          clientId: ctx.clientId,
          triggerActorId: auth.sub,
        })
      : { effects: [] };
    // Rebalance after the row exists so the new card takes part in the renumbering; the emit
    // below still goes out before card:created, matching the rebalance-before-move invariant.
    const rebalanced = positionResult.needsRebalance ? await rebalanceBoardLane(listId, boardId, tx) : null;
    const [finalCard] = await tx.select().from(cards).where(eq(cards.id, card.id)).limit(1);
    // card:created keeps the pre-automation snapshot (automation effects emit their own events)
    // but must carry the rebalanced position, or clients would place it by a stale number.
    const createdCard = rebalanced && finalCard ? { ...card, position: finalCard.position } : card;
    return { kind: "created", plan, card: createdCard, finalCard: finalCard ?? card, activity, customFieldAutomationEffects, automationEffects, assignmentAutomationEffects, labelAutomationEffects, rebalanced, laneRebalanced, linkFanout } as const;
  });
}

/** Post-commit side effects of a card create, in client-visible order; returns the response card. */
export async function emitCardCreate({ auth, mailer, result }: { auth: AuthClaims; mailer: Mailer; result: CommittedCardCreate }): Promise<WireCard> {
  if (result.kind === "replayed") return toWireCard(result.card, auth.cid);
  const { plan, card, finalCard, activity, customFieldAutomationEffects, automationEffects, assignmentAutomationEffects, labelAutomationEffects, rebalanced, laneRebalanced, linkFanout } = result;
  const { boardId, listId, ctx, assigneeIds, labelIds, customFieldValues } = plan;
  if (rebalanced) await emitLaneRebalanced(boardId, listId, rebalanced);
  if (laneRebalanced) await emitWorkspaceLaneRebalanced(listId, laneRebalanced);
  if (assigneeIds.length > 0) {
    await enqueueCardAssignedEmails({
      tx: db,
      mailer,
      webOrigin: env.WEB_ORIGIN,
      cardId: card.id,
      actorId: auth.sub,
      recipientUserIds: assigneeIds,
    });
  }
  const wireCard = toWireCard(card, auth.cid);
  await emitToBoard(boardId, SERVER_EVENTS.CARD_CREATED, { boardId, card: wireCard });
  await emitCardActivityFeedItem(boardId, card.id, activity);
  // A description that links existing cards or notes adds this card to their linked items/backlinks.
  await emitInternalLinksChanged(linkFanout);
  // All requested values were stored before any automation ran. Publish those snapshots first
  // so field/list/assignment/label rules can replace them without a stale initial value winning.
  for (const value of customFieldValues) {
    await emitToBoard(boardId, SERVER_EVENTS.CARD_CUSTOM_FIELD_VALUE_SET, { boardId, cardId: card.id, ...value });
  }
  if (assigneeIds.length > 0) {
    await emitToBoard(boardId, SERVER_EVENTS.CARD_ASSIGNEES_SET, { boardId, cardId: card.id, assigneeIds });
  }
  if (labelIds.length > 0) {
    await emitToBoard(boardId, SERVER_EVENTS.CARD_LABELS_SET, { boardId, cardId: card.id, labelIds });
  }
  await emitAutomationEffects(customFieldAutomationEffects);
  await emitAutomationEffects(automationEffects);
  await emitAutomationEffects(assignmentAutomationEffects);
  await emitAutomationEffects(labelAutomationEffects);
  // Card activity stays in Kanera's audit log. PostHog receives only the durable activation
  // milestone below, never one event per card mutation.
  await evaluateWorkspaceAnalyticsMilestones({
    workspaceId: ctx.workspaceId,
    actorId: auth.sub,
    // API and MCP card creation is real customer work. Board-mirror copies use system activity
    // and never pass through this route, so they remain excluded from the milestone.
    supportSession: auth.authKind === "support",
  });
  return toWireCard(finalCard, auth.cid);
}
