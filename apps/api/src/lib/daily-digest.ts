import {
  boardMembers,
  boards,
  cardAssignees,
  cardChecklistItems,
  cardChecklists,
  cards,
  emailQueue,
  lists,
  users,
  type CardDueDateSlot,
  type SmtpConfig,
} from "@kanera/shared/schema";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db.js";
import { isDueDateOverdue } from "./due-date.js";
import { createMailer, type Mailer } from "./mailer.js";
import { getNotificationSettingsForUsers } from "./notification-settings.js";
import { startSweepScheduler } from "./sweep-scheduler.js";

const DIGEST_HOUR = 8;
const SWEEP_INTERVAL_MS = 60_000; // 60 seconds

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
  cardTitle: string;
  boardId: string;
  boardName: string;
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
      cardTitle: cards.title,
      boardId: boards.id,
      boardName: boards.name,
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
      sql`${boardMembers.role} <> 'observer'::board_role`,
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
      cardTitle: cards.title,
      itemText: cardChecklistItems.text,
      boardId: boards.id,
      boardName: boards.name,
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
      sql`${boardMembers.role} <> 'observer'::board_role`,
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
  const emailEnabledRows = dueRows.filter((row) => settingsByUser.get(row.userId)?.emailEnabled ?? true);
  if (emailEnabledRows.length === 0) return 0;

  const mailer = deps.mailer ?? createMailer({
    db: deps.db,
    resolveSmtpConfig: deps.resolveSmtpConfig,
    webOrigin: deps.webOrigin,
    log: deps.log,
  });

  let enqueued = 0;
  for (const digest of buildDigests(emailEnabledRows, deps.webOrigin, now)) {
    if (await alreadyQueued(deps.db, digest.email, digest.localDate)) continue;
    const row = await mailer.sendDailyDigest(digest.email, "editor", {
      displayName: digest.displayName,
      localDate: digest.localDate,
      localDateLabel: digest.localDateLabel,
      dueToday: digest.dueToday,
      overdue: digest.overdue,
    });
    if (row) enqueued += 1;
  }

  if (enqueued > 0) deps.log.info({ enqueued }, "queued daily digest emails");
  return enqueued;
}

export function startDailyDigestScheduler(deps: DailyDigestDeps): () => void {
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

function buildDigests(rows: DigestCandidate[], webOrigin: string, now: Date) {
  const byUser = new Map<string, {
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
      cardUrl: cardUrl(webOrigin, row.boardId, row.cardId),
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

function cardUrl(webOrigin: string, boardId: string, cardId: string): string {
  const url = new URL(`/b/${boardId}`, webOrigin);
  url.searchParams.set("cardId", cardId);
  return url.toString();
}
