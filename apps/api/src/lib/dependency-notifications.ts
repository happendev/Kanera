import { ACTIVITY_ACTION, boards, cardAssignees, cards, cardWatchers, notifications, workspaces, type ActivityEvent } from "@kanera/shared/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db, type TxOnly } from "../db.js";
import { emitActivityFeedItem, recordActivity } from "./activity.js";
import { enqueueCardDependencyNotifications, enqueueDependencyHandoffNotifications, enqueueScheduleConflictPush } from "./assignee-email-notifications.js";
import { blockedByCounts, clearedDependents, type BlockedDependentsSnapshot } from "./card-relations.js";
import type { Mailer } from "./mailer.js";
import { enrichNotifications, notificationActorSuppressionId } from "./notifications.js";
import { recipientCanSeeCard } from "./reaction-notifications.js";
import { emitToUsersDurable } from "../realtime/emit.js";

type CardRow = typeof cards.$inferSelect;

/**
 * Tells each card's people that it became blocked, or started blocking another card. Both sides
 * hear about it because both change what someone should do next: the blocked card's people must
 * wait, the blocker's people now hold someone else up.
 *
 * The blocked card's assignees and watchers are told, since an assignee's plan just changed whether
 * or not they watch; the blocker side tells its watchers. Each person hears once: someone on both
 * sides gets only the blocked card's notification, the one that changes their own work. Card
 * watchers only (not board watchers), and never the actor unless they acted through an API key or
 * agent. The inbox entry always lands; email, push and personal channels follow the recipient's
 * "Card dependencies" settings. The other card is named by key, with its title only for recipients
 * who can open it.
 */
export async function notifyDependencyAdded(params: {
  actorId: string;
  mailer: Mailer;
  webOrigin: string;
  blocker: CardRow;
  blocked: CardRow;
  /** The relation's activity row on each card, so every notification points at its own card's entry. */
  activities: { blocker: ActivityEvent; blocked: ActivityEvent };
}): Promise<void> {
  const [workspace] = await db
    .select({ clientId: workspaces.clientId })
    .from(boards)
    .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
    .where(eq(boards.id, params.blocked.boardId))
    .limit(1);
  if (!workspace) return;
  const sides = [
    { card: params.blocked, other: params.blocker, direction: "blocked_by" as const, activity: params.activities.blocked },
    { card: params.blocker, other: params.blocked, direction: "blocks" as const, activity: params.activities.blocker },
  ];
  const notified = new Set<string>();
  for (const side of sides) {
    const suppressedUserId = notificationActorSuppressionId(side.activity);
    const [watcherRows, assigneeRows] = await Promise.all([
      db.select({ userId: cardWatchers.userId }).from(cardWatchers).where(eq(cardWatchers.cardId, side.card.id)),
      side.direction === "blocked_by"
        ? db.select({ userId: cardAssignees.userId }).from(cardAssignees).where(eq(cardAssignees.cardId, side.card.id))
        : Promise.resolve([]),
    ]);
    const recipients: string[] = [];
    const otherReadableBy = new Set<string>();
    for (const userId of new Set([...watcherRows, ...assigneeRows].map((row) => row.userId))) {
      if (userId === suppressedUserId || notified.has(userId)) continue;
      // Checked before sending: push and email carry the card title with no later access check.
      if (!(await recipientCanSeeCard(userId, workspace.clientId, side.card.boardId, side.card.id))) continue;
      recipients.push(userId);
      notified.add(userId);
      if (await recipientCanSeeCard(userId, workspace.clientId, side.other.boardId, side.other.id)) otherReadableBy.add(userId);
    }
    if (recipients.length === 0) continue;

    await insertDependencyNotifications(workspace.clientId, side.card, side.activity, recipients);
    await enqueueCardDependencyNotifications({
      tx: db,
      mailer: params.mailer,
      webOrigin: params.webOrigin,
      cardId: side.card.id,
      actorId: params.actorId,
      recipientUserIds: recipients,
      direction: side.direction,
      other: { key: side.other.key, title: side.other.title },
      otherReadableBy,
    });
  }
}

/**
 * A card that crossed the zero-open-blockers boundary because of one blocker, with the activity row
 * that records it on the dependent card. `cleared`: the last open blocker closed, the card is ready
 * to start. `reopened`: a blocker was reopened or restored, the card is blocked again.
 */
export interface DependencyHandoff {
  kind: "cleared" | "reopened";
  dependent: CardRow;
  blocker: Pick<CardRow, "id" | "key" | "title" | "boardId">;
  activity: ActivityEvent;
}

/** Record handoffs from the pre-write snapshot, including unlink and cascade-delete transitions. */
export async function recordBlockersCleared(
  tx: TxOnly,
  opts: { before: BlockedDependentsSnapshot; actorId: string | null },
): Promise<DependencyHandoff[]> {
  const unblocked = await clearedDependents(tx, opts.before);
  if (!unblocked.length) return [];
  const dependents = await tx.select().from(cards).where(inArray(cards.id, unblocked.map((row) => row.dependentId)));
  const dependentById = new Map(dependents.map((card) => [card.id, card]));
  const handoffs: DependencyHandoff[] = [];
  for (const row of unblocked) {
    const dependent = dependentById.get(row.dependentId);
    if (!dependent || dependent.completedAt || dependent.archivedAt) continue;
    handoffs.push({ kind: "cleared", dependent, blocker: row.blocker, activity: await recordHandoffActivity(tx, dependent, row.blocker, ACTIVITY_ACTION.BLOCKERS_CLEARED, opts.actorId) });
  }
  return handoffs;
}

/**
 * The reverse boundary: `blocker` was reopened or restored and `dependents` (active cards that had
 * no open blocker before the write) are blocked again. Adding a new relation is not recorded here;
 * `notifyDependencyAdded` tells both sides about that.
 */
export async function recordBlockersReopened(
  tx: TxOnly,
  opts: { dependents: readonly CardRow[]; blocker: DependencyHandoff["blocker"]; actorId: string | null },
): Promise<DependencyHandoff[]> {
  const handoffs: DependencyHandoff[] = [];
  for (const dependent of opts.dependents) {
    handoffs.push({ kind: "reopened", dependent, blocker: opts.blocker, activity: await recordHandoffActivity(tx, dependent, opts.blocker, ACTIVITY_ACTION.BLOCKERS_REOPENED, opts.actorId) });
  }
  return handoffs;
}

// Key only, like relation:added: this feed's readers may not be able to open the blocker.
function recordHandoffActivity(tx: TxOnly, dependent: CardRow, blocker: DependencyHandoff["blocker"], action: typeof ACTIVITY_ACTION.BLOCKERS_CLEARED | typeof ACTIVITY_ACTION.BLOCKERS_REOPENED, actorId: string | null) {
  return recordActivity(tx, {
    boardId: dependent.boardId,
    workspaceId: dependent.workspaceId,
    actorId,
    ...(actorId ? {} : { actorKind: "system" as const }),
    entityType: "card",
    entityId: dependent.id,
    action,
    payload: { otherCardId: blocker.id, otherCardKey: blocker.key },
  });
}

/**
 * Post-commit half of `recordBlockersCleared` / `recordBlockersReopened`: shows the row in each
 * card's feed and tells the card's assignees and card watchers it is ready to start, or blocked
 * again: whoever does the next piece of work, and whoever heard it became blocked
 * (`notifyDependencyAdded` tells watchers). Someone both assigned and watching is told once.
 *
 * The person who closed or reopened the blocker is not told about their own handoff (unless they
 * acted through an API key or agent, which is exactly what they need to review). Recipients must be
 * able to open the dependent card; the blocker is named by key, with its title only for those who
 * can open it. The inbox entry always lands; email, push and personal channels follow "Card
 * dependencies". Failures are logged by the caller and never fail the write that moved the blocker.
 *
 * The handoff was captured before the automations it triggered ran, so the feed row stays (it is
 * what happened) but the notification is only sent if it still describes the card: a card an
 * automation completed on `card_unblocked` is not "ready to start", and one it reopened and
 * re-blocked in the same chain is not "ready" either.
 */
export async function notifyDependencyHandoffs(params: {
  handoffs: readonly DependencyHandoff[];
  mailer: Mailer;
  webOrigin: string;
}): Promise<void> {
  if (!params.handoffs.length) return;
  const dependentIds = params.handoffs.map((handoff) => handoff.dependent.id);
  // Re-read the card: the handoff was captured before the automations it triggered, which may have
  // moved the card (card_unblocked -> move), so the inbox entry must point at where it is now.
  const [currentRows, counts] = await Promise.all([
    db.select({ card: cards }).from(cards).innerJoin(boards, eq(boards.id, cards.boardId))
      .where(and(inArray(cards.id, dependentIds), isNull(boards.archivedAt))),
    blockedByCounts(db, dependentIds),
  ]);
  const currentById = new Map(currentRows.map(({ card }) => [card.id, card]));
  for (const { kind, dependent: captured, blocker, activity } of params.handoffs) {
    const dependent = currentById.get(captured.id);
    // The board may have been hidden since the transaction captured this handoff. As with inbox
    // visibility and direct card access, unavailable board work must not be announced as ready.
    if (!dependent) continue;
    await emitActivityFeedItem(dependent.boardId, captured.id, activity, { notify: false });
    if (dependent.completedAt || dependent.archivedAt) continue;
    const blockedNow = (counts.get(dependent.id) ?? 0) > 0;
    if (kind === "cleared" ? blockedNow : !blockedNow) continue;
    const [workspace] = await db
      .select({ clientId: workspaces.clientId })
      .from(workspaces)
      .where(eq(workspaces.id, dependent.workspaceId))
      .limit(1);
    if (!workspace) continue;
    const suppressedUserId = notificationActorSuppressionId(activity);
    const [assigneeRows, watcherRows] = await Promise.all([
      db.select({ userId: cardAssignees.userId }).from(cardAssignees).where(eq(cardAssignees.cardId, dependent.id)),
      db.select({ userId: cardWatchers.userId }).from(cardWatchers).where(eq(cardWatchers.cardId, dependent.id)),
    ]);
    const candidates = new Set([...assigneeRows, ...watcherRows].map((row) => row.userId));
    const recipients: string[] = [];
    const blockerReadableBy = new Set<string>();
    for (const userId of candidates) {
      if (userId === suppressedUserId) continue;
      // Checked before sending: push and email carry the card title with no later access check.
      if (!(await recipientCanSeeCard(userId, workspace.clientId, dependent.boardId, dependent.id))) continue;
      recipients.push(userId);
      if (await recipientCanSeeCard(userId, workspace.clientId, blocker.boardId, blocker.id)) blockerReadableBy.add(userId);
    }
    if (recipients.length === 0) continue;

    await insertDependencyNotifications(workspace.clientId, dependent, activity, recipients);
    await enqueueDependencyHandoffNotifications({
      tx: db,
      mailer: params.mailer,
      webOrigin: params.webOrigin,
      kind,
      cardId: dependent.id,
      recipientUserIds: recipients,
      blocker: { key: blocker.key, title: blocker.title },
      blockerReadableBy,
    });
  }
}

/** A card whose plan first fell behind a blocker, with the feed row recorded for it (schedule recheck sweep). */
export interface ScheduleConflictNotice {
  card: CardRow;
  blocker: Pick<CardRow, "id" | "key" | "title" | "boardId">;
  activity: ActivityEvent;
  /** The one person whose own edits produced the conflict, if exactly one did; they are not told. */
  suppressUserId: string | null;
}

/**
 * Post-commit half of the schedule recheck: shows the conflict in the card's feed and tells its
 * assignees and card watchers that it is planned to start before a blocker finishes. Board watchers
 * are left out, as for handoffs: on a busy board a reshuffle can open several conflicts at once, and
 * the people on the card are the ones who must move a date or chase the blocker.
 *
 * It fires once per conflict because the sweep reports boundaries, not states (schedule-events.ts):
 * a card stays quiet until its conflicts all clear and a new one appears, however many edits happen
 * in between. The person who made the conflict by dragging their own bars already sees it flagged on
 * the Timeline, so they are not told. The inbox entry always lands; push and personal channels follow
 * "Card dependencies". The blocker is named by key only, since a reader may not be able to open it.
 */
export async function notifyScheduleConflicts(params: { notices: readonly ScheduleConflictNotice[]; webOrigin: string }): Promise<void> {
  for (const { card, activity, blocker, suppressUserId } of params.notices) {
    await emitActivityFeedItem(card.boardId, card.id, activity, { notify: false });
    const [current] = await db.select({ card: cards, clientId: workspaces.clientId }).from(cards)
      .innerJoin(boards, eq(boards.id, cards.boardId))
      .innerJoin(workspaces, eq(workspaces.id, cards.workspaceId))
      .where(and(eq(cards.id, card.id), isNull(boards.archivedAt)))
      .limit(1);
    if (!current || current.card.completedAt || current.card.archivedAt) continue;
    const [assigneeRows, watcherRows] = await Promise.all([
      db.select({ userId: cardAssignees.userId }).from(cardAssignees).where(eq(cardAssignees.cardId, card.id)),
      db.select({ userId: cardWatchers.userId }).from(cardWatchers).where(eq(cardWatchers.cardId, card.id)),
    ]);
    const recipients: string[] = [];
    for (const userId of new Set([...assigneeRows, ...watcherRows].map((row) => row.userId))) {
      if (userId === suppressUserId) continue;
      // Checked before sending: push carries the card title with no later access check.
      if (!(await recipientCanSeeCard(userId, current.clientId, current.card.boardId, card.id))) continue;
      recipients.push(userId);
    }
    if (recipients.length === 0) continue;
    await insertDependencyNotifications(current.clientId, current.card, activity, recipients);
    await enqueueScheduleConflictPush({ tx: db, webOrigin: params.webOrigin, cardId: card.id, recipientUserIds: recipients, blockerKey: blocker.key });
  }
}

/** The inbox entry, plus the live ping that makes the bell update without a reload. */
async function insertDependencyNotifications(clientId: string, card: CardRow, activity: ActivityEvent, recipients: readonly string[]): Promise<void> {
  const rows = await db
    .insert(notifications)
    .values(recipients.map((userId) => ({
      userId,
      clientId,
      activityId: activity.id,
      cardId: card.id,
      listId: card.listId,
      boardId: card.boardId,
      workspaceId: card.workspaceId,
      reason: "dependency" as const,
    })))
    .onConflictDoNothing()
    .returning({ id: notifications.id });
  if (!rows.length) return;
  const enriched = await enrichNotifications(db, rows.map((row) => row.id));
  await emitToUsersDurable("notification:created", enriched.map((notification) => ({ userId: notification.userId, payload: { notification } })));
}
