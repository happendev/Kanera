import {
  boardMembers,
  boards,
  cardAssignees,
  cardChecklistItems,
  cardChecklists,
  cardPriorities,
  cards,
  emailQueue,
  lists,
  users,
  type CardDueDateSlot,
  type SmtpConfig,
} from "@kanera/shared/schema";
import { cardPath } from "@kanera/shared/card-links";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DailyDigestPriorityItem } from "./email-templates/daily-digest.js";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db.js";
import { isDueDateOverdue } from "./due-date.js";
import { createMailer, type Mailer } from "./mailer.js";
import { allowsDailyDigestEmail, getNotificationSettingsForUsers, getNotificationWorkspaceRulesForUsers } from "./notification-settings.js";
import { startSweepScheduler } from "./sweep-scheduler.js";

const DIGEST_HOUR = 8;
const SWEEP_INTERVAL_MS = 60_000; // 60 seconds
/**
 * How much of the queue the digest reprints. The email answers "and of today's items, what first",
 * which the head of the queue settles; a 50-row reprint would bury the due dates it sits beside.
 */
const MAX_DIGEST_PRIORITIES = 5;

interface DigestLocalParts {
  date: string;
  hour: number;
}

interface DigestRow {
  // Cards and assigned checklist items are both surfaced as digest work items; the kind
  // discriminator drives how the item is labelled (card title vs item text + card context).
  kind: "card" | "checklistItem";
  userId: string;
  email: string;
  displayName: string;
  timezone: string;
  cardId: string;
  cardKey: string;
  organisationKey: string;
  cardTitle: string;
  boardId: string;
  boardName: string;
  workspaceId: string;
  // Checklist item text; null for card rows.
  itemText: string | null;
  dueDateLocalDate: string | null;
  dueDateSlot: CardDueDateSlot | null;
  dueDateTimezone: string | null;
}

type DigestCandidate = DigestRow & { dueDateLocalDate: string };

export interface DailyDigestDeps {
  db: Db;
  webOrigin: string;
  resolveSmtpConfig: (clientId: string) => Promise<SmtpConfig | null>;
  log: FastifyBaseLogger;
  mailer?: Pick<Mailer, "sendDailyDigest">;
}

export async function runDailyDigestSweep(deps: DailyDigestDeps, now = new Date()): Promise<number> {
  // Digest recipients must still be non-observer members of the card's board. Board membership is
  // the access model, so the join is keyed on board_member (not workspace_member); the same shape
  // is reused by the checklist-item query below.
  const cardRows = await deps.db
    .select({
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
      timezone: users.timezone,
      cardId: cards.id,
      cardKey: cards.key,
      organisationKey: cards.organisationKey,
      cardTitle: cards.title,
      boardId: boards.id,
      boardName: boards.name,
      workspaceId: boards.workspaceId,
      dueDateLocalDate: cards.dueDateLocalDate,
      dueDateSlot: cards.dueDateSlot,
      dueDateTimezone: cards.dueDateTimezone,
    })
    .from(cardAssignees)
    .innerJoin(users, eq(users.id, cardAssignees.userId))
    .innerJoin(cards, eq(cards.id, cardAssignees.cardId))
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .innerJoin(lists, eq(lists.id, cards.listId))
    .innerJoin(boardMembers, and(
      eq(boardMembers.boardId, boards.id),
      eq(boardMembers.userId, users.id),
    ))
    .where(and(
      isNull(cards.archivedAt),
      isNull(cards.completedAt),
      isNull(boards.archivedAt),
      isNull(lists.archivedAt),
      sql`${cards.dueDateLocalDate} is not null`,
      sql`${boardMembers.role} <> 'observer'`,
    ))
    .orderBy(asc(users.id), asc(cards.dueDateLocalDate), asc(boards.name), asc(cards.title))
    .limit(10_000);

  // Assigned checklist items with their own due date, joined through to the parent card and
  // board. Keyed on the item's assignee (rather than card assignees) so an item assignee who
  // does not own the card still receives it. Same active-entity and access filters as cards.
  const checklistRows = await deps.db
    .select({
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
      timezone: users.timezone,
      cardId: cards.id,
      cardKey: cards.key,
      organisationKey: cards.organisationKey,
      cardTitle: cards.title,
      itemText: cardChecklistItems.text,
      boardId: boards.id,
      boardName: boards.name,
      workspaceId: boards.workspaceId,
      dueDateLocalDate: cardChecklistItems.dueDateLocalDate,
      dueDateSlot: cardChecklistItems.dueDateSlot,
      dueDateTimezone: cardChecklistItems.dueDateTimezone,
    })
    .from(cardChecklistItems)
    .innerJoin(users, eq(users.id, cardChecklistItems.assigneeId))
    .innerJoin(cardChecklists, eq(cardChecklists.id, cardChecklistItems.checklistId))
    .innerJoin(cards, eq(cards.id, cardChecklists.cardId))
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .innerJoin(lists, eq(lists.id, cards.listId))
    .innerJoin(boardMembers, and(
      eq(boardMembers.boardId, boards.id),
      eq(boardMembers.userId, users.id),
    ))
    .where(and(
      isNull(cardChecklistItems.completedAt),
      isNull(cards.archivedAt),
      isNull(cards.completedAt),
      isNull(boards.archivedAt),
      isNull(lists.archivedAt),
      sql`${cardChecklistItems.dueDateLocalDate} is not null`,
      sql`${boardMembers.role} <> 'observer'`,
    ))
    .limit(10_000);

  // A card and one of its checklist items can both be due; they are distinct work items and
  // intentionally both appear (no dedupe).
  const rows: DigestRow[] = [
    ...cardRows.map((row) => ({ kind: "card" as const, ...row, itemText: null })),
    ...checklistRows.map((row) => ({ kind: "checklistItem" as const, ...row })),
  ];

  const dueRows = rows.filter((row): row is DigestCandidate => {
    if (!row.dueDateLocalDate) return false;
    const recipientLocal = localParts(now, row.timezone);
    if (recipientLocal.hour !== DIGEST_HOUR) return false;
    const dueLocal = localParts(now, row.dueDateTimezone || "UTC");
    return row.dueDateLocalDate <= dueLocal.date;
  });
  if (dueRows.length === 0) return 0;
  const settingsByUser = await getNotificationSettingsForUsers(deps.db, dueRows.map((row) => row.userId));
  const rulesByUser = await getNotificationWorkspaceRulesForUsers(
    deps.db,
    dueRows.map((row) => row.userId),
    dueRows.map((row) => row.workspaceId),
  );
  const emailEnabledRows = dueRows.filter((row) => {
    const settings = settingsByUser.get(row.userId);
    if (!settings) return true;
    return allowsDailyDigestEmail(settings, {
      rule: rulesByUser.get(row.userId)?.get(row.workspaceId),
    });
  });
  if (emailEnabledRows.length === 0) return 0;

  const mailer = deps.mailer ?? createMailer({
    db: deps.db,
    resolveSmtpConfig: deps.resolveSmtpConfig,
    webOrigin: deps.webOrigin,
    log: deps.log,
  });

  // One batch query for every recipient rather than one per digest: the sweep already holds the
  // whole recipient set, and a queue read per user would scale with the organisation.
  const prioritiesByUser = await loadDigestPriorities(
    deps.db,
    [...new Set(emailEnabledRows.map((row) => row.userId))],
    deps.webOrigin,
    now,
  );

  let enqueued = 0;
  for (const digest of buildDigests(emailEnabledRows, deps.webOrigin, now)) {
    if (await alreadyQueued(deps.db, digest.email, digest.localDate)) continue;
    const row = await mailer.sendDailyDigest(digest.email, "editor", {
      displayName: digest.displayName,
      localDate: digest.localDate,
      localDateLabel: digest.localDateLabel,
      dueToday: digest.dueToday,
      overdue: digest.overdue,
      priorities: prioritiesByUser.get(digest.userId) ?? [],
    });
    if (row) enqueued += 1;
  }

  if (enqueued > 0) deps.log.info({ enqueued }, "queued daily digest emails");
  return enqueued;
}

export function startDailyDigestScheduler(deps: DailyDigestDeps): () => Promise<void> {
  // Align the first run to the top of the next hour so digests land on hour boundaries,
  // then re-check every minute (the sweep is idempotent per user/date, so the frequent
  // cadence only catches recipients whose 8am boundary just passed).
  return startSweepScheduler({
    name: "daily-digest",
    task: () => runDailyDigestSweep(deps),
    runImmediately: false,
    firstDelayMs: delayToNextHour,
    nextDelayMs: SWEEP_INTERVAL_MS,
    log: deps.log,
  }).stop;
}

export function delayToNextHour(now = new Date()): number {
  const next = new Date(now);
  next.setHours(now.getHours() + 1, 0, 0, 0);
  return Math.max(1_000, next.getTime() - now.getTime());
}

/**
 * The head of each recipient's own "Up next" queue.
 *
 * Deliberately the *same* row set and ordering the queue endpoint numbers — assigned, not completed,
 * not archived, ordered by position then card id — and deliberately no `board_member` join. Ranks
 * are a property of the queue's owner, so filtering by anything else would print a #3 in the email
 * beside a #4 in the app for the same card, which is worse than omitting the section.
 *
 * The digest's send gate is untouched: a queue alone never triggers an email, or a durable queue
 * would mail the same list every morning forever. This section only rides along with due work.
 */
async function loadDigestPriorities(
  db: Db,
  userIds: string[],
  webOrigin: string,
  now: Date,
): Promise<Map<string, DailyDigestPriorityItem[]>> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .select({
      targetUserId: cardPriorities.targetUserId,
      cardKey: cards.key,
      organisationKey: cards.organisationKey,
      cardTitle: cards.title,
      boardName: boards.name,
      dueDateLocalDate: cards.dueDateLocalDate,
      dueDateTimezone: cards.dueDateTimezone,
    })
    .from(cardPriorities)
    .innerJoin(cards, eq(cards.id, cardPriorities.cardId))
    .innerJoin(cardAssignees, and(
      eq(cardAssignees.cardId, cardPriorities.cardId),
      eq(cardAssignees.userId, cardPriorities.targetUserId),
    ))
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .innerJoin(lists, eq(lists.id, cards.listId))
    .where(and(
      inArray(cardPriorities.targetUserId, userIds),
      isNull(cards.archivedAt),
      isNull(cards.completedAt),
    ))
    .orderBy(asc(cardPriorities.targetUserId), asc(cardPriorities.position), asc(cards.id));

  const byUser = new Map<string, DailyDigestPriorityItem[]>();
  for (const row of rows) {
    const items = byUser.get(row.targetUserId) ?? [];
    // Rank comes from the full ordered set before truncation, so #1..#5 always mean the same thing
    // here as in the app — the slice only decides how many are printed.
    const rank = items.length + 1;
    if (rank > MAX_DIGEST_PRIORITIES) continue;
    const dueLocal = localParts(now, row.dueDateTimezone || "UTC");
    items.push({
      rank,
      title: row.cardTitle,
      boardName: row.boardName,
      cardUrl: cardUrl(webOrigin, row.organisationKey, row.cardKey),
      dueLabel: !row.dueDateLocalDate
        ? null
        : row.dueDateLocalDate === dueLocal.date
          ? "Today"
          : `Due ${shortDateLabel(row.dueDateLocalDate, row.dueDateTimezone || "UTC")}`,
    });
    byUser.set(row.targetUserId, items);
  }
  return byUser;
}

function buildDigests(rows: DigestCandidate[], webOrigin: string, now: Date) {
  const byUser = new Map<string, {
    userId: string;
    email: string;
    displayName: string;
    timezone: string;
    localDate: string;
    localDateLabel: string;
    dueToday: DigestItem[];
    overdue: DigestItem[];
  }>();

  for (const row of rows) {
    const recipientLocal = localParts(now, row.timezone);
    const dueLocal = localParts(now, row.dueDateTimezone || "UTC");
    const digest = byUser.get(row.userId) ?? {
      userId: row.userId,
      email: row.email,
      displayName: row.displayName,
      timezone: row.timezone,
      localDate: recipientLocal.date,
      localDateLabel: localDateLabel(now, row.timezone),
      dueToday: [],
      overdue: [],
    };
    byUser.set(row.userId, digest);

    // For checklist items the headline is the item text, with the parent card title shown as
    // context; cards keep their title and have no context line. cardUrl deep-links to the card
    // (which is where the checklist lives) for both kinds.
    const item = {
      title: row.kind === "checklistItem" && row.itemText ? row.itemText : row.cardTitle,
      boardName: row.boardName,
      context: row.kind === "checklistItem" ? row.cardTitle : null,
      cardUrl: cardUrl(webOrigin, row.organisationKey, row.cardKey),
      dueLabel: row.dueDateLocalDate === dueLocal.date ? "Today" : `Due ${shortDateLabel(row.dueDateLocalDate, row.dueDateTimezone || "UTC")}`,
    };
    if (isDueDateOverdue(row, now)) digest.overdue.push(item);
    else if (row.dueDateLocalDate === dueLocal.date) digest.dueToday.push(item);
  }

  return [...byUser.values()];
}

type DigestItem = {
  title: string;
  boardName: string;
  context: string | null;
  cardUrl: string;
  dueLabel: string;
};

async function alreadyQueued(db: Db, toEmail: string, localDate: string): Promise<boolean> {
  const [existing] = await db
    .select({ id: emailQueue.id })
    .from(emailQueue)
    .where(and(
      eq(emailQueue.toEmail, toEmail),
      eq(emailQueue.type, "daily_digest"),
      sql`${emailQueue.data}->>'localDate' = ${localDate}`,
    ))
    .limit(1);
  return Boolean(existing);
}

function localParts(now: Date, timezone: string): DigestLocalParts {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
      hourCycle: "h23",
    }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
      hourCycle: "h23",
    }).formatToParts(now);
  }

  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const rawHour = Number(value("hour"));
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    hour: rawHour === 24 ? 0 : rawHour,
  };
}

function localDateLabel(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone || "UTC",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(now);
}

function shortDateLabel(localDate: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone || "UTC",
    month: "short",
    day: "numeric",
  }).format(new Date(`${localDate}T12:00:00Z`));
}

function cardUrl(webOrigin: string, organisationKey: string, cardKey: string): string {
  return new URL(cardPath(organisationKey, cardKey), webOrigin).toString();
}
