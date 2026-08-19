import { ACTIVITY_ACTION, activityEvents, boards, boardWatchers, cardAssignees, cards, cardWatchers, lists, notifications, workspaces, type ActivityEvent, type CardDueDateSlot } from "@kanera/shared/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { db, type Db } from "../db.js";
import { env } from "../env.js";
import { enqueueOverdueWatcherOutbound } from "./watched-activity-push.js";
import { emitToUser } from "../realtime/emit.js";
import { emitActivityFeedItem, recordActivity } from "./activity.js";
import { loadAssignedChecklistItems } from "./assigned-checklist-items.js";
import { enqueueOverdueAssigneeEmails, enqueueOverdueChecklistItemAssigneeEmails } from "./assignee-email-notifications.js";
import { isDueDateOverdue } from "./due-date.js";
import { createMailer, type Mailer } from "./mailer.js";
import { enrichNotifications } from "./notifications.js";
import { resolveSmtpConfig } from "./smtp-resolve.js";
import { startSweepScheduler } from "./sweep-scheduler.js";

type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

interface OverdueCandidate {
  cardId: string;
  listId: string;
  boardId: string;
  workspaceId: string;
  dueDateLocalDate: string | null;
  dueDateSlot: CardDueDateSlot | null;
  dueDateTimezone: string | null;
}

interface OverdueCardCandidate {
  clientId: string;
  cardId: string;
  listId: string;
  boardId: string;
  workspaceId: string;
  dueDateLocalDate: string | null;
  dueDateSlot: CardDueDateSlot | null;
  dueDateTimezone: string | null;
}

type OverdueActivityPayload = Record<string, unknown> & {
  dueDateLocalDate: string | null;
  dueDateSlot: CardDueDateSlot | null;
  dueDateTimezone: string | null;
};

export function isCandidateOverdue(candidate: OverdueCandidate, now = new Date()): boolean {
  return isDueDateOverdue(candidate, now);
}

async function loadOverdueCardCandidates(tx: Tx, cardIds?: string[]): Promise<OverdueCardCandidate[]> {
  const conditions = [
    isNull(cards.archivedAt),
    isNull(cards.completedAt),
    isNull(lists.archivedAt),
    isNull(boards.archivedAt),
    sql`${cards.dueDateLocalDate} is not null`,
  ];
  if (cardIds) {
    if (cardIds.length === 0) return [];
    conditions.push(inArray(cards.id, cardIds));
  }

  return tx
    .select({
      cardId: cards.id,
      listId: cards.listId,
      boardId: cards.boardId,
      workspaceId: lists.workspaceId,
      clientId: workspaces.clientId,
      dueDateLocalDate: cards.dueDateLocalDate,
      dueDateSlot: cards.dueDateSlot,
      dueDateTimezone: cards.dueDateTimezone,
    })
    .from(cards)
    .innerJoin(lists, eq(lists.id, cards.listId))
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .innerJoin(workspaces, eq(workspaces.id, lists.workspaceId))
    .where(and(...conditions))
    .limit(5000);
}

async function resolveOverdueRecipients(tx: Tx, cardIds: string[]): Promise<Map<string, Set<string>>> {
  const recipientsByCard = new Map<string, Set<string>>();
  if (cardIds.length === 0) return recipientsByCard;

  const assignees = await tx
    .select({ cardId: cardAssignees.cardId, userId: cardAssignees.userId })
    .from(cardAssignees)
    .where(inArray(cardAssignees.cardId, cardIds));
  const cardWatcherRows = await tx
    .select({ cardId: cardWatchers.cardId, userId: cardWatchers.userId })
    .from(cardWatchers)
    .where(inArray(cardWatchers.cardId, cardIds));
  const boardWatcherRows = await tx
    .select({ cardId: cards.id, userId: boardWatchers.userId })
    .from(cards)
    .innerJoin(boardWatchers, eq(boardWatchers.boardId, cards.boardId))
    .where(inArray(cards.id, cardIds));

  const add = (cardId: string, userId: string) => {
    const recipients = recipientsByCard.get(cardId) ?? new Set<string>();
    recipients.add(userId);
    recipientsByCard.set(cardId, recipients);
  };
  for (const row of assignees) add(row.cardId, row.userId);
  for (const row of cardWatcherRows) add(row.cardId, row.userId);
  for (const row of boardWatcherRows) add(row.cardId, row.userId);
  return recipientsByCard;
}

async function resolveOverdueAssignees(tx: Tx, cardIds: string[]): Promise<Map<string, Set<string>>> {
  const recipientsByCard = new Map<string, Set<string>>();
  if (cardIds.length === 0) return recipientsByCard;
  const assignees = await tx
    .select({ cardId: cardAssignees.cardId, userId: cardAssignees.userId })
    .from(cardAssignees)
    .where(inArray(cardAssignees.cardId, cardIds));
  for (const row of assignees) {
    const recipients = recipientsByCard.get(row.cardId) ?? new Set<string>();
    recipients.add(row.userId);
    recipientsByCard.set(row.cardId, recipients);
  }
  return recipientsByCard;
}

function overdueActivityPayload(card: OverdueCardCandidate): OverdueActivityPayload {
  return {
    dueDateLocalDate: card.dueDateLocalDate,
    dueDateSlot: card.dueDateSlot,
    dueDateTimezone: card.dueDateTimezone,
  };
}

// Dedupe key matching hasOverdueActivity's `is not distinct from` semantics: a card
// already has an OVERDUE activity for this exact due-date snapshot. `\u0000` stands in
// for SQL NULL so null fields compare equal across the JSON->>text and candidate values.
function overdueActivityDedupeKey(
  entityId: string,
  dueDateLocalDate: string | null,
  dueDateSlot: string | null,
  dueDateTimezone: string | null,
): string {
  return [entityId, dueDateLocalDate ?? "\u0000", dueDateSlot ?? "\u0000", dueDateTimezone ?? "\u0000"].join("\u0001");
}

// Batch-load the dedupe keys of existing OVERDUE activities for the candidate cards in a
// single query. Previously this was one existence query per candidate inside the loop,
// which is up to 5000 sequential round-trips per sweep.
async function loadExistingOverdueActivityKeys(tx: Tx, cardIds: string[]): Promise<Set<string>> {
  const keys = new Set<string>();
  if (cardIds.length === 0) return keys;
  const rows = await tx
    .select({
      entityId: activityEvents.entityId,
      dueDateLocalDate: sql<string | null>`${activityEvents.payload}->>'dueDateLocalDate'`,
      dueDateSlot: sql<string | null>`${activityEvents.payload}->>'dueDateSlot'`,
      dueDateTimezone: sql<string | null>`${activityEvents.payload}->>'dueDateTimezone'`,
    })
    .from(activityEvents)
    .where(and(
      eq(activityEvents.entityType, "card"),
      eq(activityEvents.action, ACTIVITY_ACTION.OVERDUE),
      inArray(activityEvents.entityId, cardIds),
    ));
  for (const row of rows) {
    keys.add(overdueActivityDedupeKey(row.entityId, row.dueDateLocalDate, row.dueDateSlot, row.dueDateTimezone));
  }
  return keys;
}

async function createOverdueActivities(tx: Tx, overdueCards: OverdueCardCandidate[]): Promise<ActivityEvent[]> {
  const existingKeys = await loadExistingOverdueActivityKeys(tx, overdueCards.map((card) => card.cardId));
  const activities: ActivityEvent[] = [];
  for (const card of overdueCards) {
    const key = overdueActivityDedupeKey(card.cardId, card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone);
    if (existingKeys.has(key)) continue;
    // Track the key we just created so any later candidate with the same snapshot in this
    // batch is skipped too (the old per-card query saw prior inserts within the same tx).
    existingKeys.add(key);
    activities.push(await recordActivity(tx, {
      boardId: card.boardId,
      workspaceId: card.workspaceId,
      actorId: null,
      actorKind: "system",
      entityType: "card",
      entityId: card.cardId,
      action: ACTIVITY_ACTION.OVERDUE,
      payload: overdueActivityPayload(card),
    }));
  }
  return activities;
}

export async function createOverdueNotificationsForCards(
  tx: Tx,
  cardIds: string[],
  now = new Date(),
  options?: { mailer?: Mailer; webOrigin?: string; log?: FastifyBaseLogger },
): Promise<number> {
  const cardCandidates = await loadOverdueCardCandidates(tx, cardIds);
  if (cardCandidates.length === 0) return 0;

  const recipientsByCard = await resolveOverdueRecipients(tx, cardCandidates.map((candidate) => candidate.cardId));
  const assigneesByCard = await resolveOverdueAssignees(tx, cardCandidates.map((candidate) => candidate.cardId));
  const overdueCards = cardCandidates.filter((candidate) => isCandidateOverdue(candidate, now));
  const overdueActivities = await createOverdueActivities(tx, overdueCards);
  for (const activity of overdueActivities) {
    emitActivityFeedItem(activity.boardId!, activity.entityId, activity, { notify: false });
  }
  const overdue = overdueCards.flatMap((card) =>
    Array.from(recipientsByCard.get(card.cardId) ?? []).map((userId) => ({ ...card, userId })),
  );

  let insertedCount = 0;
  for (let i = 0; i < overdue.length; i += 100) {
    const batch = overdue.slice(i, i + 100);
    const inserted = await tx
      .insert(notifications)
      .values(batch.map((candidate) => ({
        userId: candidate.userId,
        clientId: candidate.clientId,
        activityId: null,
        cardId: candidate.cardId,
        listId: candidate.listId,
        boardId: candidate.boardId,
        workspaceId: candidate.workspaceId,
        reason: "overdue" as const,
      })))
      .onConflictDoNothing()
      .returning({ id: notifications.id, userId: notifications.userId, cardId: notifications.cardId });
    insertedCount += inserted.length;
    const enriched = await enrichNotifications(tx, inserted.map((row) => row.id));
    for (const row of enriched) {
      emitToUser(row.userId, "notification:created", { notification: row });
    }
    const overdueEmailRecipients = inserted
      .filter((row) => assigneesByCard.get(row.cardId ?? "")?.has(row.userId))
      .map((row) => ({ cardId: row.cardId!, userId: row.userId }));
    // Watchers who are not assignees get no email - only push and personal channels, and only if
    // they opted into watched-activity delivery. Assignees are excluded here because
    // enqueueOverdueAssigneeEmails already covers their push on the same tag.
    const overdueWatcherIds = new Set(
      inserted
        .filter((row) => !assigneesByCard.get(row.cardId ?? "")?.has(row.userId))
        .map((row) => row.id),
    );
    if (overdueWatcherIds.size > 0) {
      await enqueueOverdueWatcherOutbound(tx, enriched.filter((row) => overdueWatcherIds.has(row.id)));
    }
    if (overdueEmailRecipients.length > 0) {
      await enqueueOverdueAssigneeEmails({
        tx,
        mailer: options?.mailer ?? createMailer({
          db: tx as Db,
          resolveSmtpConfig,
          webOrigin: options?.webOrigin ?? env.WEB_ORIGIN,
          log: options?.log ?? ({ info() { }, error() { }, warn() { }, debug() { } } as never),
        }),
        webOrigin: options?.webOrigin ?? env.WEB_ORIGIN,
        cardUserIds: overdueEmailRecipients,
      });
    }
  }

  return insertedCount;
}

interface OverdueChecklistItemCandidate {
  clientId: string;
  itemId: string;
  assigneeId: string;
  text: string;
  cardId: string;
  listId: string;
  boardId: string;
  workspaceId: string;
  dueDateLocalDate: string | null;
  dueDateSlot: CardDueDateSlot | null;
  dueDateTimezone: string | null;
}

async function loadOverdueChecklistItemCandidates(tx: Tx, itemIds?: string[]): Promise<OverdueChecklistItemCandidate[]> {
  // Reuse the canonical assigned-checklist-item join. The overdue sweep wants every
  // assigned, due-dated item across all boards, optionally narrowed to specific items.
  const rows = await loadAssignedChecklistItems(tx, itemIds ? { itemIds } : {});
  return rows.map((row) => ({
    itemId: row.itemId,
    assigneeId: row.assigneeId,
    text: row.text,
    cardId: row.cardId,
    listId: row.listId,
    boardId: row.boardId,
    workspaceId: row.workspaceId,
    clientId: row.clientId,
    dueDateLocalDate: row.dueDateLocalDate,
    dueDateSlot: row.dueDateSlot,
    dueDateTimezone: row.dueDateTimezone,
  }));
}

export async function createOverdueNotificationsForChecklistItems(
  tx: Tx,
  itemIds: string[],
  now = new Date(),
  options?: { mailer?: Mailer; webOrigin?: string; log?: FastifyBaseLogger },
): Promise<number> {
  const candidates = await loadOverdueChecklistItemCandidates(tx, itemIds);
  if (candidates.length === 0) return 0;

  const overdue = candidates.filter((candidate) => isCandidateOverdue(candidate, now));
  if (overdue.length === 0) return 0;

  let insertedCount = 0;
  for (let i = 0; i < overdue.length; i += 100) {
    const batch = overdue.slice(i, i + 100);
    const inserted = await tx
      .insert(notifications)
      .values(batch.map((candidate) => ({
        userId: candidate.assigneeId,
        clientId: candidate.clientId,
        activityId: null,
        cardId: candidate.cardId,
        checklistItemId: candidate.itemId,
        listId: candidate.listId,
        boardId: candidate.boardId,
        workspaceId: candidate.workspaceId,
        reason: "checklist_item_overdue" as const,
      })))
      .onConflictDoNothing()
      .returning({ id: notifications.id, userId: notifications.userId, checklistItemId: notifications.checklistItemId });
    insertedCount += inserted.length;
    const enriched = await enrichNotifications(tx, inserted.map((row) => row.id));
    for (const row of enriched) {
      emitToUser(row.userId, "notification:created", { notification: row });
    }
    const emailRecipients = inserted
      .filter((row) => row.checklistItemId)
      .map((row) => ({ itemId: row.checklistItemId!, userId: row.userId }));
    if (emailRecipients.length > 0) {
      await enqueueOverdueChecklistItemAssigneeEmails({
        tx,
        mailer: options?.mailer ?? createMailer({
          db: tx as Db,
          resolveSmtpConfig,
          webOrigin: options?.webOrigin ?? env.WEB_ORIGIN,
          log: options?.log ?? ({ info() { }, error() { }, warn() { }, debug() { } } as never),
        }),
        webOrigin: options?.webOrigin ?? env.WEB_ORIGIN,
        itemUserIds: emailRecipients,
      });
    }
  }

  return insertedCount;
}

export async function runOverdueNotificationSweep(log?: FastifyBaseLogger): Promise<number> {
  const candidates = await loadOverdueCardCandidates(db);

  const insertedCount = await createOverdueNotificationsForCards(
    db,
    candidates.map((candidate) => candidate.cardId),
  );

  const checklistItemCandidates = await loadOverdueChecklistItemCandidates(db);
  const checklistInsertedCount = await createOverdueNotificationsForChecklistItems(
    db,
    checklistItemCandidates.map((candidate) => candidate.itemId),
  );

  const total = insertedCount + checklistInsertedCount;
  if (total > 0) log?.info({ insertedCount, checklistInsertedCount }, "created overdue notifications");
  return total;
}

function delayToNextHour(now = new Date()): number {
  const next = new Date(now);
  next.setHours(now.getHours() + 1, 0, 0, 0);
  return Math.max(1_000, next.getTime() - now.getTime());
}

export function startOverdueNotificationScheduler(log: FastifyBaseLogger): () => Promise<void> {
  return startSweepScheduler({
    name: "overdue-notification",
    task: () => runOverdueNotificationSweep(log),
    nextDelayMs: () => delayToNextHour(),
    log,
  }).stop;
}
