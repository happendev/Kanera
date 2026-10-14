import { requestContext } from "@fastify/request-context";
import { boards, cardAssignees, cardChecklistItems, cardChecklists, cards, users, workspaces, type CardDueDateSlot, type PushQueueReason } from "@kanera/shared/schema";
import { eq, inArray } from "drizzle-orm";
import type { Db, Tx } from "../db.js";
import type { Locale } from "@kanera/shared/locales";
import { formatLocalDate } from "./i18n/format.js";
import { serverMessages } from "./i18n/messages/index.js";
import { recipientLocale } from "./i18n/request-locale.js";
import type { Mailer } from "./mailer.js";
import { allowsNotificationEmail, allowsNotificationPush, allowsPersonalNotificationChannel, getNotificationSettingsForUsers, getNotificationWorkspaceRulesForUsers, isClientPushEnabled, type EffectiveNotificationSettings, type EffectiveNotificationWorkspaceRule, type NotificationPreferenceType, type NotificationWorkspaceRuleScope } from "./notification-settings.js";
import { enqueuePersonalNotification, enqueuePush } from "./push-queue.js";
import { agentActorName } from "./agent-actor-name.js";
import { absoluteCardUrl } from "./wire-card.js";

interface CardEmailContext {
  cardId: string;
  organisationKey: string;
  cardKey: string;
  cardTitle: string;
  boardId: string;
  boardName: string;
  workspaceId: string;
  clientId: string;
}

type WorkspaceRulesByUser = Map<string, Map<string, EffectiveNotificationWorkspaceRule>>;

function deliveryScope(
  rules: WorkspaceRulesByUser,
  userId: string,
  ctx: { workspaceId: string },
): NotificationWorkspaceRuleScope {
  return { rule: rules.get(userId)?.get(ctx.workspaceId) };
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
  const rules = await getNotificationWorkspaceRulesForUsers(params.tx, recipients.map((recipient) => recipient.id), [ctx.workspaceId]);
  const cardUrlValue = cardUrl(params.webOrigin, ctx.organisationKey, ctx.cardKey);
  await Promise.all(recipients.map(async (recipient) => {
    const preference = settings.get(recipient.id)!;
    if (allowsNotificationEmail(preference, "cardAssigned", deliveryScope(rules, recipient.id, ctx))) {
      const locale = recipientLocale(recipient.locale);
      await params.mailer.sendCardAssigned(recipient.email, {
        locale,
        displayName: recipient.displayName,
        actorName: actorName(locale),
        cardTitle: ctx.cardTitle,
        boardName: ctx.boardName,
        cardUrl: cardUrlValue,
      });
    }
  }));
  await enqueuePushForRecipients(params.tx, recipients, settings, rules, ctx, "cardAssigned", "assigned", (locale) => {
    const m = serverMessages(locale).push.cardAssigned;
    return {
      kind: "card_assigned",
      title: m.title,
      body: m.body({ actor: actorName(locale), card: ctx.cardTitle }),
      url: cardUrlValue,
      tag: `card:${ctx.cardId}:assigned`,
    };
  });
  return recipients.filter((recipient) => allowsNotificationEmail(settings.get(recipient.id)!, "cardAssigned", deliveryScope(rules, recipient.id, ctx))).length;
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
  const rules = await getNotificationWorkspaceRulesForUsers(params.tx, recipients.map((recipient) => recipient.id), [ctx.workspaceId]);
  const commentExcerpt = commentEmailExcerpt(params.commentBody);
  const cardUrlValue = cardUrl(params.webOrigin, ctx.organisationKey, ctx.cardKey);
  await Promise.all(recipients.map(async (recipient) => {
    const preference = settings.get(recipient.id)!;
    if (!allowsNotificationEmail(preference, "cardCommentAdded", deliveryScope(rules, recipient.id, ctx))) return;
    const locale = recipientLocale(recipient.locale);
    await params.mailer.sendCardCommentAdded(recipient.email, {
      locale,
      displayName: recipient.displayName,
      actorName: actorName(locale),
      cardTitle: ctx.cardTitle,
      boardName: ctx.boardName,
      cardUrl: cardUrlValue,
      commentExcerpt: excerptOrFallback(commentExcerpt, locale),
    });
  }));
  await enqueuePushForRecipients(params.tx, recipients, settings, rules, ctx, "cardCommentAdded", "comment", (locale) => {
    const m = serverMessages(locale).push.commentAdded;
    return {
      kind: "card_comment_added",
      title: m.title,
      body: m.body({ actor: actorName(locale), board: ctx.boardName, card: ctx.cardTitle, excerpt: excerptOrFallback(commentExcerpt, locale) }),
      url: cardUrlValue,
      tag: `card:${ctx.cardId}:comment`,
    };
  });
  return recipients.filter((recipient) => allowsNotificationEmail(settings.get(recipient.id)!, "cardCommentAdded", deliveryScope(rules, recipient.id, ctx))).length;
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
  const rules = await getNotificationWorkspaceRulesForUsers(params.tx, recipients.map((recipient) => recipient.id), [ctx.workspaceId]);
  const commentExcerpt = commentEmailExcerpt(params.commentBody);
  const cardUrlValue = cardUrl(params.webOrigin, ctx.organisationKey, ctx.cardKey);
  await Promise.all(recipients.map(async (recipient) => {
    const preference = settings.get(recipient.id)!;
    if (!allowsNotificationEmail(preference, "commentMentioned", deliveryScope(rules, recipient.id, ctx))) return;
    const locale = recipientLocale(recipient.locale);
    await params.mailer.sendCommentMentioned(recipient.email, {
      locale,
      displayName: recipient.displayName,
      actorName: actorName(locale),
      cardTitle: ctx.cardTitle,
      boardName: ctx.boardName,
      cardUrl: cardUrlValue,
      commentExcerpt: excerptOrFallback(commentExcerpt, locale),
    });
  }));
  await enqueuePushForRecipients(params.tx, recipients, settings, rules, ctx, "commentMentioned", "mentioned", (locale) => {
    const m = serverMessages(locale).push.mentioned;
    return {
      kind: "comment_mentioned",
      title: m.title,
      body: m.body({ actor: actorName(locale), board: ctx.boardName, card: ctx.cardTitle, excerpt: excerptOrFallback(commentExcerpt, locale) }),
      url: cardUrlValue,
      tag: `card:${ctx.cardId}:mentioned`,
    };
  });
  return recipients.filter((recipient) => allowsNotificationEmail(settings.get(recipient.id)!, "commentMentioned", deliveryScope(rules, recipient.id, ctx))).length;
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
  const rules = await getNotificationWorkspaceRulesForUsers(params.tx, recipients.map((recipient) => recipient.id), [ctx.workspaceId]);
  const cardUrlValue = cardUrl(params.webOrigin, ctx.organisationKey, ctx.cardKey);
  await Promise.all(recipients.map(async (recipient) => {
    const preference = settings.get(recipient.id)!;
    if (!allowsNotificationEmail(preference, "cardDueDateChanged", deliveryScope(rules, recipient.id, ctx))) return;
    const locale = recipientLocale(recipient.locale);
    await params.mailer.sendCardDueDateChanged(recipient.email, {
      locale,
      displayName: recipient.displayName,
      actorName: actorName(locale),
      cardTitle: ctx.cardTitle,
      boardName: ctx.boardName,
      cardUrl: cardUrlValue,
      previousDueLabel: dueLabel(params.previousDue, locale),
      nextDueLabel: dueLabel(params.nextDue, locale),
    });
  }));
  await enqueuePushForRecipients(params.tx, recipients, settings, rules, ctx, "cardDueDateChanged", "dueDateChanged", (locale) => {
    const m = serverMessages(locale).push.dueDateChanged;
    return {
      kind: "card_due_date_changed",
      title: m.title,
      body: m.body({ actor: actorName(locale), card: ctx.cardTitle }),
      url: cardUrlValue,
      tag: `card:${ctx.cardId}:due-date`,
    };
  });
  return recipients.filter((recipient) => allowsNotificationEmail(settings.get(recipient.id)!, "cardDueDateChanged", deliveryScope(rules, recipient.id, ctx))).length;
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
      organisationKey: cards.organisationKey,
      cardKey: cards.key,
      cardTitle: cards.title,
      boardId: boards.id,
      boardName: boards.name,
      workspaceId: boards.workspaceId,
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
  const rules = await getNotificationWorkspaceRulesForUsers(
    params.tx,
    recipients.map((recipient) => recipient.id),
    contexts.map((ctx) => ctx.workspaceId),
  );

  let enqueued = 0;
  await Promise.all(params.cardUserIds.map(async ({ cardId, userId }) => {
    const ctx = ctxByCardId.get(cardId);
    const recipient = recipientById.get(userId);
    if (!ctx || !recipient) return;
    const preference = settings.get(recipient.id)!;
    if (allowsNotificationEmail(preference, "cardOverdue", deliveryScope(rules, recipient.id, ctx))) {
      const locale = recipientLocale(recipient.locale);
      await params.mailer.sendCardOverdue(recipient.email, {
        locale,
        displayName: recipient.displayName,
        cardTitle: ctx.cardTitle,
        boardName: ctx.boardName,
        cardUrl: cardUrl(params.webOrigin, ctx.organisationKey, ctx.cardKey),
        dueLabel: dueLabel(ctx, locale),
      });
      enqueued += 1;
    }
  }));
  const clientEnabledById = new Map<string, boolean>();
  await Promise.all(params.cardUserIds.map(async ({ cardId, userId }) => {
    const ctx = ctxByCardId.get(cardId);
    const recipient = recipientById.get(userId);
    if (!ctx || !recipient) return;
    const m = serverMessages(recipientLocale(recipient.locale)).push.cardOverdue;
    const payload = {
      kind: "card_overdue",
      title: m.title,
      body: m.body({ card: ctx.cardTitle }),
      url: cardUrl(params.webOrigin, ctx.organisationKey, ctx.cardKey),
      tag: `card:${ctx.cardId}:overdue`,
    };
    const scope = deliveryScope(rules, recipient.id, ctx);
    await enqueuePersonalChannelsForRecipient(params.tx, recipient, settings.get(recipient.id)!, "cardOverdue", "overdue", payload, scope);
    let clientEnabled = clientEnabledById.get(ctx.clientId);
    if (clientEnabled === undefined) {
      clientEnabled = await isClientPushEnabled(params.tx, ctx.clientId);
      clientEnabledById.set(ctx.clientId, clientEnabled);
    }
    if (!clientEnabled || !allowsNotificationPush(settings.get(recipient.id)!, "cardOverdue", scope)) return;
    await enqueuePush(params.tx as Db, {
      clientId: ctx.clientId,
      userId: recipient.id,
      reason: "overdue",
      payload,
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
      organisationKey: cards.organisationKey,
      cardKey: cards.key,
      cardTitle: cards.title,
      boardId: boards.id,
      boardName: boards.name,
      workspaceId: boards.workspaceId,
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
  const rules = await getNotificationWorkspaceRulesForUsers(
    params.tx,
    recipients.map((recipient) => recipient.id),
    contexts.map((ctx) => ctx.workspaceId),
  );

  let enqueued = 0;
  await Promise.all(params.itemUserIds.map(async ({ itemId, userId }) => {
    const ctx = ctxByItemId.get(itemId);
    const recipient = recipientById.get(userId);
    if (!ctx || !recipient) return;
    // Reuses the existing "Card overdue" preference per product decision.
    if (allowsNotificationEmail(settings.get(recipient.id)!, "cardOverdue", deliveryScope(rules, recipient.id, ctx))) {
      const locale = recipientLocale(recipient.locale);
      await params.mailer.sendChecklistItemOverdue(recipient.email, {
        locale,
        displayName: recipient.displayName,
        itemText: ctx.itemText,
        cardTitle: ctx.cardTitle,
        boardName: ctx.boardName,
        cardUrl: cardUrl(params.webOrigin, ctx.organisationKey, ctx.cardKey),
        dueLabel: dueLabel(ctx, locale),
      });
      enqueued += 1;
    }
  }));
  const clientEnabledById = new Map<string, boolean>();
  await Promise.all(params.itemUserIds.map(async ({ itemId, userId }) => {
    const ctx = ctxByItemId.get(itemId);
    const recipient = recipientById.get(userId);
    if (!ctx || !recipient) return;
    const m = serverMessages(recipientLocale(recipient.locale)).push.checklistItemOverdue;
    const payload = {
      kind: "checklist_item_overdue",
      title: m.title,
      body: m.body({ item: ctx.itemText, card: ctx.cardTitle }),
      url: cardUrl(params.webOrigin, ctx.organisationKey, ctx.cardKey),
      tag: `checklistItem:${ctx.itemId}:overdue`,
    };
    const scope = deliveryScope(rules, recipient.id, ctx);
    await enqueuePersonalChannelsForRecipient(params.tx, recipient, settings.get(recipient.id)!, "cardOverdue", "overdue", payload, scope);
    let clientEnabled = clientEnabledById.get(ctx.clientId);
    if (clientEnabled === undefined) {
      clientEnabled = await isClientPushEnabled(params.tx, ctx.clientId);
      clientEnabledById.set(ctx.clientId, clientEnabled);
    }
    if (!clientEnabled || !allowsNotificationPush(settings.get(recipient.id)!, "cardOverdue", scope)) return;
    await enqueuePush(params.tx as Db, {
      clientId: ctx.clientId,
      userId: recipient.id,
      reason: "overdue",
      payload,
    });
  }));
  return enqueued;
}

/**
 * Outbound delivery for fired card reminders. Unlike the other senders here there is no actor to
 * suppress: the recipient set the reminder for themselves, so the person being reminded is always
 * the one who asked. The per-type `cardReminder` row and the workspace rule still apply, so a user
 * can keep reminders in-app only.
 */
export async function enqueueCardReminderOutbound(params: {
  tx: Tx;
  mailer: Mailer;
  webOrigin: string;
  reminders: { cardId: string; userId: string; reminderId: string }[];
}): Promise<void> {
  if (params.reminders.length === 0) return;
  const cardIds = Array.from(new Set(params.reminders.map((row) => row.cardId)));
  const contexts = await params.tx
    .select({
      cardId: cards.id,
      organisationKey: cards.organisationKey,
      cardKey: cards.key,
      cardTitle: cards.title,
      boardId: boards.id,
      boardName: boards.name,
      workspaceId: boards.workspaceId,
      clientId: workspaces.clientId,
    })
    .from(cards)
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
    .where(inArray(cards.id, cardIds));
  const ctxByCardId = new Map(contexts.map((row) => [row.cardId, row]));
  const recipients = await loadRecipients(params.tx, params.reminders.map((row) => row.userId), null);
  const recipientById = new Map(recipients.map((row) => [row.id, row]));
  const settings = await getNotificationSettingsForUsers(params.tx, recipients.map((recipient) => recipient.id));
  const rules = await getNotificationWorkspaceRulesForUsers(
    params.tx,
    recipients.map((recipient) => recipient.id),
    contexts.map((ctx) => ctx.workspaceId),
  );
  const clientEnabledById = new Map<string, boolean>();
  for (const { cardId, userId, reminderId } of params.reminders) {
    const ctx = ctxByCardId.get(cardId);
    const recipient = recipientById.get(userId);
    if (!ctx || !recipient) continue;
    const preference = settings.get(recipient.id)!;
    const scope = deliveryScope(rules, recipient.id, ctx);
    const url = cardUrl(params.webOrigin, ctx.organisationKey, ctx.cardKey);
    const locale = recipientLocale(recipient.locale);
    if (allowsNotificationEmail(preference, "cardReminder", scope)) {
      await params.mailer.sendCardReminder(recipient.email, {
        locale,
        displayName: recipient.displayName,
        cardTitle: ctx.cardTitle,
        boardName: ctx.boardName,
        cardUrl: url,
      });
    }
    const payload = {
      kind: "card_reminder",
      title: serverMessages(locale).push.reminder.title,
      body: ctx.cardTitle,
      url,
      // Per reminder, not per card: a rescheduled reminder must not be collapsed into the last one.
      tag: `card:${ctx.cardId}:reminder:${reminderId}`,
    };
    await enqueuePersonalChannelsForRecipient(params.tx, recipient, preference, "cardReminder", "reminder", payload, scope);
    let clientEnabled = clientEnabledById.get(ctx.clientId);
    if (clientEnabled === undefined) {
      clientEnabled = await isClientPushEnabled(params.tx, ctx.clientId);
      clientEnabledById.set(ctx.clientId, clientEnabled);
    }
    if (!clientEnabled || !allowsNotificationPush(preference, "cardReminder", scope)) continue;
    await enqueuePush(params.tx as Db, { clientId: ctx.clientId, userId: recipient.id, reason: "reminder", payload });
  }
}

type PushPayload = Parameters<typeof enqueuePush>[1]["payload"];

async function enqueuePushForRecipients(
  tx: Tx,
  recipients: { id: string; clientId: string; locale: string | null }[],
  settings: Map<string, EffectiveNotificationSettings>,
  rules: WorkspaceRulesByUser,
  ctx: { workspaceId: string; boardId: string; clientId: string },
  type: NotificationPreferenceType,
  reason: PushQueueReason,
  /** Built per recipient, so each one reads the notification in their own language. */
  buildPayload: (locale: Locale) => PushPayload,
): Promise<number> {
  if (recipients.length === 0) return 0;
  let enqueued = 0;
  let clientEnabled: boolean | undefined;
  for (const recipient of recipients) {
    const preference = settings.get(recipient.id);
    if (!preference) continue;
    const scope = deliveryScope(rules, recipient.id, ctx);
    const payload = buildPayload(recipientLocale(recipient.locale));
    await enqueuePersonalChannelsForRecipient(tx, recipient, preference, type, reason, payload, scope);
    if (!allowsNotificationPush(preference, type, scope)) continue;
    if (clientEnabled === undefined) {
      clientEnabled = await isClientPushEnabled(tx, ctx.clientId);
    }
    if (!clientEnabled) continue;
    await enqueuePush(tx as Db, {
      // Queue and policy scope follow the event's organisation. Device subscriptions are
      // identity-scoped at delivery time, so a switch never suppresses cross-org push.
      clientId: ctx.clientId,
      userId: recipient.id,
      reason,
      payload,
    });
    enqueued += 1;
  }
  return enqueued;
}

async function enqueuePersonalChannelsForRecipient(
  tx: Tx,
  recipient: { id: string; clientId: string },
  settings: EffectiveNotificationSettings,
  type: NotificationPreferenceType,
  reason: PushQueueReason,
  payload: PushPayload,
  scope: NotificationWorkspaceRuleScope,
): Promise<number> {
  let enqueued = 0;
  for (const channel of ["ntfy", "gotify", "webhook"] as const) {
    if (!allowsPersonalNotificationChannel(settings, type, channel, scope) || !settings.personalChannels[channel].configured) continue;
    await enqueuePersonalNotification(tx as Db, {
      clientId: recipient.clientId,
      userId: recipient.id,
      reason,
      channel,
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
      organisationKey: cards.organisationKey,
      cardKey: cards.key,
      cardTitle: cards.title,
      boardId: boards.id,
      boardName: boards.name,
      workspaceId: boards.workspaceId,
      clientId: workspaces.clientId,
    })
    .from(cards)
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
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

/** The actor's display name in a given recipient's language (only agent attribution has words). */
type ActorName = (locale: Locale) => string;

async function resolveActorName(tx: Tx, actorId: string): Promise<ActorName | null> {
  const authKind = requestContext.get("authKind");
  if (authKind === "apiKey") {
    // API keys borrow the creator user id for tenancy, but human-facing outbound
    // notifications should name the integration that actually made the change.
    const apiKeyName = requestContext.get("apiKeyName") ?? "API key";
    return () => apiKeyName;
  }
  const actor = await loadUser(tx, actorId);
  if (!actor) return null;
  // An agent acts as its owner, so the person is the actor; naming the agent too matches the
  // in-app "via <agent>" chip and tells the owner this was delegated work, not their own.
  if (authKind === "agent") {
    const agentName = requestContext.get("agentName");
    return (locale) => agentActorName(actor.displayName, agentName, locale);
  }
  return () => actor.displayName;
}

function actorSuppressionId(actorId: string): string | null {
  // Self-suppression is for people acting by hand. API keys and agents borrow the owner's id, and
  // the owner needs to hear about what was done on their behalf (see notificationActorSuppressionId).
  const authKind = requestContext.get("authKind");
  return authKind === "apiKey" || authKind === "agent" ? null : actorId;
}

async function loadRecipients(tx: Tx, userIds: string[], actorId: string | null) {
  const uniqueUserIds = Array.from(new Set(userIds)).filter((userId) => userId !== actorId);
  if (uniqueUserIds.length === 0) return [];
  return tx
    .select({ id: users.id, clientId: users.clientId, email: users.email, displayName: users.displayName, locale: users.locale })
    .from(users)
    .where(inArray(users.id, uniqueUserIds));
}

/** A card or item due date in the recipient's language: "27 May 2026, end of workday". */
function dueLabel(input: DueLabelInput, locale: Locale): string | null {
  if (!input.dueDateLocalDate) return null;
  const common = serverMessages(locale).common;
  const date = formatLocalDate(locale, input.dueDateLocalDate, { month: "short", day: "numeric", year: "numeric" });
  const slot = slotLabel(input.dueDateSlot, common.dueSlots);
  return slot ? common.dueDateWithSlot({ date, slot }) : date;
}

function slotLabel(slot: CardDueDateSlot | null, labels: { morning: string; afternoon: string; endOfWorkDay: string }): string | null {
  switch (slot) {
    case "morning":
      return labels.morning;
    case "afternoon":
      return labels.afternoon;
    case "endOfWorkDay":
      return labels.endOfWorkDay;
    case "anyTime":
    case null:
      return null;
  }
}

function commentEmailExcerpt(markdown: string): string {
  const text = markdown
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[`*_>#-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // Empty means nothing readable (an image-only comment); callers substitute per-language wording.
  if (text.length <= 240) return text;
  return `${text.slice(0, 237).trimEnd()}...`;
}

function excerptOrFallback(excerpt: string, locale: Locale): string {
  return excerpt || serverMessages(locale).common.emptyCommentExcerpt;
}

function cardUrl(webOrigin: string, organisationKey: string, cardKey: string): string {
  return absoluteCardUrl(organisationKey, cardKey, webOrigin);
}
