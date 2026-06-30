import { requestContext } from "@fastify/request-context";
import { boards, cardAssignees, cardChecklistItems, cardChecklists, cards, users, workspaces, type CardDueDateSlot, type PushQueueReason } from "@kanera/shared/schema";
import { eq, inArray } from "drizzle-orm";
import type { Db } from "../db.js";
import type { Mailer } from "./mailer.js";
import { allowsNotificationEmail, allowsNotificationPush, getNotificationSettingsForUsers, isClientPushEnabled, type EffectiveNotificationSettings, type NotificationPreferenceType } from "./notification-settings.js";
import { enqueuePush } from "./push-queue.js";

type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

interface CardEmailContext {
  cardId: string;
  cardTitle: string;
  boardId: string;
  boardName: string;
  clientId: string;
}

export interface DueLabelInput {
  dueDateLocalDate: string | null;
  dueDateSlot: CardDueDateSlot | null;
  dueDateTimezone: string | null;
}

export async function enqueueCardAssignedEmails(params: {
  tx: Tx;
  mailer: Mailer;
  webOrigin: string;
  cardId: string;
  actorId: string;
  recipientUserIds: string[];
}): Promise<number> {
  const recipients = await loadRecipients(params.tx, params.recipientUserIds, actorSuppressionId(params.actorId));
  if (recipients.length === 0) return 0;
  const [ctx, actorName] = await Promise.all([
    loadCardEmailContext(params.tx, params.cardId),
    resolveActorName(params.tx, params.actorId),
  ]);
  if (!ctx || !actorName) return 0;
  const settings = await getNotificationSettingsForUsers(params.tx, recipients.map((recipient) => recipient.id));
  const cardUrlValue = cardUrl(params.webOrigin, ctx.boardId, ctx.cardId);
  await Promise.all(recipients.map(async (recipient) => {
    const preference = settings.get(recipient.id)!;
    if (allowsNotificationEmail(preference, "cardAssigned")) {
      await params.mailer.sendCardAssigned(recipient.email, {
        displayName: recipient.displayName,
        actorName,
        cardTitle: ctx.cardTitle,
        boardName: ctx.boardName,
        cardUrl: cardUrlValue,
      });
    }
  }));
  await enqueuePushForRecipients(params.tx, ctx.clientId, recipients, settings, "cardAssigned", "assigned", {
    kind: "card_assigned",
    title: "Card assigned",
    body: `${actorName} assigned you to ${ctx.cardTitle}`,
    url: cardUrlValue,
    tag: `card:${ctx.cardId}:assigned`,
  });
  return recipients.filter((recipient) => allowsNotificationEmail(settings.get(recipient.id)!, "cardAssigned")).length;
}

export async function enqueueCommentAddedEmails(params: {
  tx: Tx;
  mailer: Mailer;
  webOrigin: string;
  cardId: string;
  actorId: string;
  commentBody: string;
  excludeUserIds?: string[];
}): Promise<number> {
  const assignees = await params.tx
    .select({ userId: cardAssignees.userId })
    .from(cardAssignees)
    .where(eq(cardAssignees.cardId, params.cardId));
  const excluded = new Set(params.excludeUserIds ?? []);
  const recipients = (await loadRecipients(params.tx, assignees.map((row) => row.userId), actorSuppressionId(params.actorId)))
    .filter((recipient) => !excluded.has(recipient.id));
  if (recipients.length === 0) return 0;
  const [ctx, actorName] = await Promise.all([
    loadCardEmailContext(params.tx, params.cardId),
    resolveActorName(params.tx, params.actorId),
  ]);
  if (!ctx || !actorName) return 0;
  const settings = await getNotificationSettingsForUsers(params.tx, recipients.map((recipient) => recipient.id));
  const commentExcerpt = commentEmailExcerpt(params.commentBody);
  const cardUrlValue = cardUrl(params.webOrigin, ctx.boardId, ctx.cardId);
  await Promise.all(recipients.map(async (recipient) => {
    const preference = settings.get(recipient.id)!;
    if (!allowsNotificationEmail(preference, "cardCommentAdded")) return;
    await params.mailer.sendCardCommentAdded(recipient.email, {
      displayName: recipient.displayName,
      actorName,
      cardTitle: ctx.cardTitle,
      boardName: ctx.boardName,
      cardUrl: cardUrlValue,
      commentExcerpt,
    });
  }));
  await enqueuePushForRecipients(params.tx, ctx.clientId, recipients, settings, "cardCommentAdded", "comment", {
    kind: "card_comment_added",
    title: "New comment",
    body: `${actorName} commented in ${ctx.boardName} / ${ctx.cardTitle}: ${commentExcerpt}`,
    url: cardUrlValue,
    tag: `card:${ctx.cardId}:comment`,
  });
  return recipients.filter((recipient) => allowsNotificationEmail(settings.get(recipient.id)!, "cardCommentAdded")).length;
}

export async function enqueueCommentMentionedNotifications(params: {
  tx: Tx;
  mailer: Mailer;
  webOrigin: string;
  cardId: string;
  actorId: string;
  recipientUserIds: string[];
  commentBody: string;
}): Promise<number> {
  const recipients = await loadRecipients(params.tx, params.recipientUserIds, actorSuppressionId(params.actorId));
  if (recipients.length === 0) return 0;
  const [ctx, actorName] = await Promise.all([
    loadCardEmailContext(params.tx, params.cardId),
    resolveActorName(params.tx, params.actorId),
  ]);
  if (!ctx || !actorName) return 0;
  const settings = await getNotificationSettingsForUsers(params.tx, recipients.map((recipient) => recipient.id));
  const commentExcerpt = commentEmailExcerpt(params.commentBody);
  const cardUrlValue = cardUrl(params.webOrigin, ctx.boardId, ctx.cardId);
  await Promise.all(recipients.map(async (recipient) => {
    const preference = settings.get(recipient.id)!;
    if (!allowsNotificationEmail(preference, "commentMentioned")) return;
    await params.mailer.sendCommentMentioned(recipient.email, {
      displayName: recipient.displayName,
      actorName,
      cardTitle: ctx.cardTitle,
      boardName: ctx.boardName,
      cardUrl: cardUrlValue,
      commentExcerpt,
    });
  }));
  await enqueuePushForRecipients(params.tx, ctx.clientId, recipients, settings, "commentMentioned", "mentioned", {
    kind: "comment_mentioned",
    title: "Mentioned in a comment",
    body: `${actorName} mentioned you in ${ctx.boardName} / ${ctx.cardTitle}: ${commentExcerpt}`,
    url: cardUrlValue,
    tag: `card:${ctx.cardId}:mentioned`,
  });
  return recipients.filter((recipient) => allowsNotificationEmail(settings.get(recipient.id)!, "commentMentioned")).length;
}

export async function enqueueDueDateChangedEmails(params: {
  tx: Tx;
  mailer: Mailer;
  webOrigin: string;
  cardId: string;
  actorId: string;
  previousDue: DueLabelInput;
  nextDue: DueLabelInput;
}): Promise<number> {
  const assignees = await params.tx
    .select({ userId: cardAssignees.userId })
    .from(cardAssignees)
    .where(eq(cardAssignees.cardId, params.cardId));
  const recipients = await loadRecipients(params.tx, assignees.map((row) => row.userId), actorSuppressionId(params.actorId));
  if (recipients.length === 0) return 0;
  const [ctx, actorName] = await Promise.all([
    loadCardEmailContext(params.tx, params.cardId),
    resolveActorName(params.tx, params.actorId),
  ]);
  if (!ctx || !actorName) return 0;
  const settings = await getNotificationSettingsForUsers(params.tx, recipients.map((recipient) => recipient.id));
  const previousDueLabel = dueLabel(params.previousDue);
  const nextDueLabel = dueLabel(params.nextDue);
  const cardUrlValue = cardUrl(params.webOrigin, ctx.boardId, ctx.cardId);
  await Promise.all(recipients.map(async (recipient) => {
    const preference = settings.get(recipient.id)!;
    if (!allowsNotificationEmail(preference, "cardDueDateChanged")) return;
    await params.mailer.sendCardDueDateChanged(recipient.email, {
      displayName: recipient.displayName,
      actorName,
      cardTitle: ctx.cardTitle,
      boardName: ctx.boardName,
      cardUrl: cardUrlValue,
      previousDueLabel,
      nextDueLabel,
    });
  }));
  await enqueuePushForRecipients(params.tx, ctx.clientId, recipients, settings, "cardDueDateChanged", "dueDateChanged", {
    kind: "card_due_date_changed",
    title: "Due date changed",
    body: `${actorName} changed the due date on ${ctx.cardTitle}`,
    url: cardUrlValue,
    tag: `card:${ctx.cardId}:due-date`,
  });
  return recipients.filter((recipient) => allowsNotificationEmail(settings.get(recipient.id)!, "cardDueDateChanged")).length;
}

export async function enqueueOverdueAssigneeEmails(params: {
  tx: Tx;
  mailer: Mailer;
  webOrigin: string;
  cardUserIds: { cardId: string; userId: string }[];
}): Promise<number> {
  if (params.cardUserIds.length === 0) return 0;
  const cardIds = Array.from(new Set(params.cardUserIds.map((row) => row.cardId)));
  const contexts = await params.tx
    .select({
      cardId: cards.id,
      cardTitle: cards.title,
      boardId: boards.id,
      boardName: boards.name,
      clientId: workspaces.clientId,
      dueDateLocalDate: cards.dueDateLocalDate,
      dueDateSlot: cards.dueDateSlot,
      dueDateTimezone: cards.dueDateTimezone,
    })
    .from(cards)
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
    .where(inArray(cards.id, cardIds));
  const ctxByCardId = new Map(contexts.map((row) => [row.cardId, row]));
  const recipients = await loadRecipients(params.tx, params.cardUserIds.map((row) => row.userId), null);
  const recipientById = new Map(recipients.map((row) => [row.id, row]));
  const settings = await getNotificationSettingsForUsers(params.tx, recipients.map((recipient) => recipient.id));

  let enqueued = 0;
  await Promise.all(params.cardUserIds.map(async ({ cardId, userId }) => {
    const ctx = ctxByCardId.get(cardId);
    const recipient = recipientById.get(userId);
    if (!ctx || !recipient) return;
    const preference = settings.get(recipient.id)!;
    if (allowsNotificationEmail(preference, "cardOverdue")) {
      await params.mailer.sendCardOverdue(recipient.email, {
        displayName: recipient.displayName,
        cardTitle: ctx.cardTitle,
        boardName: ctx.boardName,
        cardUrl: cardUrl(params.webOrigin, ctx.boardId, ctx.cardId),
        dueLabel: dueLabel(ctx),
      });
      enqueued += 1;
    }
  }));
  const clientEnabledById = new Map<string, boolean>();
  await Promise.all(params.cardUserIds.map(async ({ cardId, userId }) => {
    const ctx = ctxByCardId.get(cardId);
    const recipient = recipientById.get(userId);
    if (!ctx || !recipient) return;
    let clientEnabled = clientEnabledById.get(ctx.clientId);
    if (clientEnabled === undefined) {
      clientEnabled = await isClientPushEnabled(params.tx, ctx.clientId);
      clientEnabledById.set(ctx.clientId, clientEnabled);
    }
    if (!clientEnabled || !allowsNotificationPush(settings.get(recipient.id)!, "cardOverdue")) return;
    await enqueuePush(params.tx as Db, {
      clientId: ctx.clientId,
      userId: recipient.id,
      reason: "overdue",
      payload: {
        kind: "card_overdue",
        title: "Card overdue",
        body: `${ctx.cardTitle} is overdue`,
        url: cardUrl(params.webOrigin, ctx.boardId, ctx.cardId),
        tag: `card:${ctx.cardId}:overdue`,
      },
    });
  }));
  return enqueued;
}

export async function enqueueOverdueChecklistItemAssigneeEmails(params: {
  tx: Tx;
  mailer: Mailer;
  webOrigin: string;
  itemUserIds: { itemId: string; userId: string }[];
}): Promise<number> {
  if (params.itemUserIds.length === 0) return 0;
  const itemIds = Array.from(new Set(params.itemUserIds.map((row) => row.itemId)));
  const contexts = await params.tx
    .select({
      itemId: cardChecklistItems.id,
      itemText: cardChecklistItems.text,
      dueDateLocalDate: cardChecklistItems.dueDateLocalDate,
      dueDateSlot: cardChecklistItems.dueDateSlot,
      dueDateTimezone: cardChecklistItems.dueDateTimezone,
      cardId: cards.id,
      cardTitle: cards.title,
      boardId: boards.id,
      boardName: boards.name,
      clientId: workspaces.clientId,
    })
    .from(cardChecklistItems)
    .innerJoin(cardChecklists, eq(cardChecklists.id, cardChecklistItems.checklistId))
    .innerJoin(cards, eq(cards.id, cardChecklists.cardId))
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
    .where(inArray(cardChecklistItems.id, itemIds));
  const ctxByItemId = new Map(contexts.map((row) => [row.itemId, row]));
  const recipients = await loadRecipients(params.tx, params.itemUserIds.map((row) => row.userId), null);
  const recipientById = new Map(recipients.map((row) => [row.id, row]));
  const settings = await getNotificationSettingsForUsers(params.tx, recipients.map((recipient) => recipient.id));

  let enqueued = 0;
  await Promise.all(params.itemUserIds.map(async ({ itemId, userId }) => {
    const ctx = ctxByItemId.get(itemId);
    const recipient = recipientById.get(userId);
    if (!ctx || !recipient) return;
    // Reuses the existing "Card overdue" preference per product decision.
    if (allowsNotificationEmail(settings.get(recipient.id)!, "cardOverdue")) {
      await params.mailer.sendChecklistItemOverdue(recipient.email, {
        displayName: recipient.displayName,
        itemText: ctx.itemText,
        cardTitle: ctx.cardTitle,
        boardName: ctx.boardName,
        cardUrl: cardUrl(params.webOrigin, ctx.boardId, ctx.cardId),
        dueLabel: dueLabel(ctx),
      });
      enqueued += 1;
    }
  }));
  const clientEnabledById = new Map<string, boolean>();
  await Promise.all(params.itemUserIds.map(async ({ itemId, userId }) => {
    const ctx = ctxByItemId.get(itemId);
    const recipient = recipientById.get(userId);
    if (!ctx || !recipient) return;
    let clientEnabled = clientEnabledById.get(ctx.clientId);
    if (clientEnabled === undefined) {
      clientEnabled = await isClientPushEnabled(params.tx, ctx.clientId);
      clientEnabledById.set(ctx.clientId, clientEnabled);
    }
    if (!clientEnabled || !allowsNotificationPush(settings.get(recipient.id)!, "cardOverdue")) return;
    await enqueuePush(params.tx as Db, {
      clientId: ctx.clientId,
      userId: recipient.id,
      reason: "overdue",
      payload: {
        kind: "checklist_item_overdue",
        title: "Checklist item overdue",
        body: `${ctx.itemText} is overdue on ${ctx.cardTitle}`,
        url: cardUrl(params.webOrigin, ctx.boardId, ctx.cardId),
        tag: `checklistItem:${ctx.itemId}:overdue`,
      },
    });
  }));
  return enqueued;
}

async function enqueuePushForRecipients(
  tx: Tx,
  clientId: string,
  recipients: { id: string }[],
  settings: Map<string, EffectiveNotificationSettings>,
  type: NotificationPreferenceType,
  reason: PushQueueReason,
  payload: Parameters<typeof enqueuePush>[1]["payload"],
): Promise<number> {
  if (recipients.length === 0 || !await isClientPushEnabled(tx, clientId)) return 0;
  let enqueued = 0;
  for (const recipient of recipients) {
    const preference = settings.get(recipient.id);
    if (!preference || !allowsNotificationPush(preference, type)) continue;
    await enqueuePush(tx as Db, {
      clientId,
      userId: recipient.id,
      reason,
      payload,
    });
    enqueued += 1;
  }
  return enqueued;
}

async function loadCardEmailContext(tx: Tx, cardId: string): Promise<CardEmailContext | null> {
  const [row] = await tx
    .select({
      cardId: cards.id,
      cardTitle: cards.title,
      boardId: boards.id,
      boardName: boards.name,
      clientId: users.clientId,
    })
    .from(cards)
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .innerJoin(users, eq(users.id, cards.createdById))
    .where(eq(cards.id, cardId))
    .limit(1);
  return row ?? null;
}

async function loadUser(tx: Tx, userId: string) {
  const [row] = await tx
    .select({ id: users.id, email: users.email, displayName: users.displayName })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row ?? null;
}

async function resolveActorName(tx: Tx, actorId: string): Promise<string | null> {
  if (requestContext.get("authKind") === "apiKey") {
    // API keys borrow the creator user id for tenancy, but human-facing outbound
    // notifications should name the integration that actually made the change.
    return requestContext.get("apiKeyName") ?? "API key";
  }
  const actor = await loadUser(tx, actorId);
  return actor?.displayName ?? null;
}

function actorSuppressionId(actorId: string): string | null {
  return requestContext.get("authKind") === "apiKey" ? null : actorId;
}

async function loadRecipients(tx: Tx, userIds: string[], actorId: string | null) {
  const uniqueUserIds = Array.from(new Set(userIds)).filter((userId) => userId !== actorId);
  if (uniqueUserIds.length === 0) return [];
  return tx
    .select({ id: users.id, email: users.email, displayName: users.displayName })
    .from(users)
    .where(inArray(users.id, uniqueUserIds));
}

export function dueLabel(input: DueLabelInput): string | null {
  if (!input.dueDateLocalDate) return null;
  const date = shortDateLabel(input.dueDateLocalDate, input.dueDateTimezone || "UTC");
  const slot = slotLabel(input.dueDateSlot);
  return slot ? `${date}, ${slot}` : date;
}

function slotLabel(slot: CardDueDateSlot | null): string | null {
  switch (slot) {
    case "morning":
      return "morning";
    case "afternoon":
      return "afternoon";
    case "endOfWorkDay":
      return "end of workday";
    case "anyTime":
    case null:
      return null;
  }
}

function shortDateLabel(localDate: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone || "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${localDate}T12:00:00Z`));
}

function commentEmailExcerpt(markdown: string): string {
  const text = markdown
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[`*_>#-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= 240) return text || "View the comment in Kanera.";
  return `${text.slice(0, 237).trimEnd()}...`;
}

function cardUrl(webOrigin: string, boardId: string, cardId: string): string {
  const url = new URL(`/b/${boardId}`, webOrigin);
  url.searchParams.set("cardId", cardId);
  return url.toString();
}
