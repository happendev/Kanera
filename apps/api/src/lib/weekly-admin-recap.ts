import type { Locale } from "@kanera/shared/locales";
import {
  activityEvents,
  boardInvitations,
  boards,
  clients,
  EMAIL_QUEUE_STATUS,
  emailQueue,
  users,
  workspaces,
  type BillingEmailQueueData,
  type WeeklyAdminRecapUpcomingGroup,
} from "@kanera/shared/schema";
import { and, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db.js";
import type { WeeklyAdminRecapEmailParams } from "./email-templates/index.js";
import { formatDate } from "./i18n/format.js";
import { serverMessages } from "./i18n/messages/index.js";
import { recipientLocale } from "./i18n/request-locale.js";
import { emailSubject } from "./mailer.js";
import { startSweepScheduler } from "./sweep-scheduler.js";

const SEND_HOUR_UTC = 7;
const SWEEP_INTERVAL_MS = 60_000;
const DAY_MS = 86_400_000;

export interface WeeklyAdminRecapDeps {
  db: Db;
  adminEmail?: string;
  adminUrl: string;
  log: FastifyBaseLogger;
}

type UpcomingSubscription = {
  name: string;
  seatLimit: number;
  currentPeriodEnd: Date;
};

export async function runWeeklyAdminRecapSweep(deps: WeeklyAdminRecapDeps, now = new Date()): Promise<number> {
  if (!deps.adminEmail) return 0;
  const thisMonday = mondayUtc(now);
  const dueAt = new Date(thisMonday.getTime() + SEND_HOUR_UTC * 60 * 60_000);
  if (now < dueAt) return 0;

  const lastMonday = new Date(thisMonday.getTime() - 7 * DAY_MS);
  const nextMonday = new Date(thisMonday.getTime() + 7 * DAY_MS);
  // The recap address is configuration, not an account; if it belongs to one, use its language.
  const [adminAccount] = await deps.db.select({ locale: users.locale }).from(users).where(eq(users.email, deps.adminEmail)).limit(1);
  const locale = recipientLocale(adminAccount?.locale);
  const data = await buildWeeklyAdminRecap(deps.db, locale, lastMonday, thisMonday, nextMonday, deps.adminUrl);
  const [queued] = await deps.db
    .insert(emailQueue)
    .values({
      toEmail: deps.adminEmail,
      subject: emailSubject(serverMessages(locale).email.weeklyAdminRecap.queueSubject({ period: data.lastWeekLabel })),
      type: "weekly_admin_recap",
      data,
      status: EMAIL_QUEUE_STATUS.queued,
    })
    // The partial unique index on recipient + periodStart is the final idempotency guard. The read
    // sweep intentionally stays stateless so a restarted worker catches up later in the same week.
    .onConflictDoNothing()
    .returning({ id: emailQueue.id });
  if (!queued) return 0;
  deps.log.info({ emailQueueId: queued.id, periodStart: data.periodStart }, "queued weekly admin recap");
  return 1;
}

async function buildWeeklyAdminRecap(
  database: Db,
  locale: Locale,
  lastMonday: Date,
  thisMonday: Date,
  nextMonday: Date,
  adminUrl: string,
): Promise<WeeklyAdminRecapEmailParams> {
  const countRows = async (query: Promise<Array<{ count: unknown }>>) => Number((await query)[0]?.count ?? 0);

  const [
    newAccounts,
    newOrganisations,
    boardsCreated,
    orgInvitesAccepted,
    boardInvitesAccepted,
    subscriptionsStarted,
    activeAccounts,
    activeOrganisations,
    activeBoards,
    paidOrganisations,
    trialOrganisations,
    purchasedSeatsRow,
    seatEmailRows,
    upcomingRows,
  ] = await Promise.all([
    countRows(database.select({ count: sql<number>`count(*)` }).from(users)
      .innerJoin(clients, eq(clients.id, users.clientId))
      .where(and(eq(clients.analyticsExcluded, false), gte(users.createdAt, lastMonday), lt(users.createdAt, thisMonday)))),
    countRows(database.select({ count: sql<number>`count(*)` }).from(clients).where(and(eq(clients.analyticsExcluded, false), gte(clients.createdAt, lastMonday), lt(clients.createdAt, thisMonday)))),
    countRows(database.select({ count: sql<number>`count(*)` }).from(boards)
      .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
      .innerJoin(clients, eq(clients.id, workspaces.clientId))
      .where(and(eq(clients.analyticsExcluded, false), gte(boards.createdAt, lastMonday), lt(boards.createdAt, thisMonday)))),
    countRows(database.select({ count: sql<number>`count(*)` }).from(activityEvents)
      .innerJoin(clients, eq(clients.id, activityEvents.clientId))
      .where(and(
        eq(clients.analyticsExcluded, false),
        eq(activityEvents.entityType, "workspaceMember"),
        eq(activityEvents.action, "added"),
        sql`${activityEvents.payload}->>'inviteId' is not null`,
        gte(activityEvents.createdAt, lastMonday),
        lt(activityEvents.createdAt, thisMonday),
      ))),
    countRows(database.select({ count: sql<number>`count(*)` }).from(boardInvitations)
      .innerJoin(clients, eq(clients.id, boardInvitations.clientId))
      .where(and(
        eq(clients.analyticsExcluded, false),
        gte(boardInvitations.acceptedAt, lastMonday),
        lt(boardInvitations.acceptedAt, thisMonday),
      ))),
    countRows(database.select({ count: sql<number>`count(*)` }).from(clients).where(and(
      eq(clients.analyticsExcluded, false),
      gte(clients.analyticsSubscriptionStartedAt, lastMonday),
      lt(clients.analyticsSubscriptionStartedAt, thisMonday),
    ))),
    countRows(database.select({ count: sql<number>`count(*)` }).from(users)
      .innerJoin(clients, eq(clients.id, users.clientId))
      .where(and(eq(clients.analyticsExcluded, false), isNull(users.deletedAt)))),
    countRows(database.select({ count: sql<number>`count(*)` }).from(clients).where(and(eq(clients.analyticsExcluded, false), isNull(clients.deletedAt)))),
    countRows(database.select({ count: sql<number>`count(*)` }).from(boards)
      .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
      .innerJoin(clients, eq(clients.id, workspaces.clientId))
      .where(and(eq(clients.analyticsExcluded, false), isNull(boards.archivedAt)))),
    countRows(database.select({ count: sql<number>`count(*)` }).from(clients).where(and(
      eq(clients.analyticsExcluded, false),
      isNull(clients.deletedAt),
      inArray(clients.billingStatus, ["active", "past_due"]),
    ))),
    countRows(database.select({ count: sql<number>`count(*)` }).from(clients).where(and(
      eq(clients.analyticsExcluded, false),
      isNull(clients.deletedAt),
      eq(clients.billingStatus, "trialing"),
    ))),
    database.select({ count: sql<number>`coalesce(sum(${clients.seatLimit}), 0)` }).from(clients).where(and(
      eq(clients.analyticsExcluded, false),
      isNull(clients.deletedAt),
      inArray(clients.billingStatus, ["active", "past_due"]),
    )),
    database.select({ type: emailQueue.type, data: emailQueue.data, createdAt: emailQueue.createdAt }).from(emailQueue)
      .innerJoin(clients, sql`${emailQueue.data}->>'clientId' = ${clients.id}::text`)
      .where(and(
        eq(clients.analyticsExcluded, false),
        inArray(emailQueue.type, ["seat_billed", "upgraded_to_pro", "welcome_to_pro"]),
        gte(emailQueue.createdAt, lastMonday),
        lt(emailQueue.createdAt, thisMonday),
      )),
    database.select({
      name: clients.name,
      seatLimit: clients.seatLimit,
      billingStatus: clients.billingStatus,
      cancelAtPeriodEnd: clients.cancelAtPeriodEnd,
      currentPeriodEnd: clients.currentPeriodEnd,
    }).from(clients).where(and(
      eq(clients.analyticsExcluded, false),
      isNull(clients.deletedAt),
      gte(clients.currentPeriodEnd, thisMonday),
      lt(clients.currentPeriodEnd, nextMonday),
      inArray(clients.billingStatus, ["active", "trialing"]),
    )),
  ]);

  const renewals: UpcomingSubscription[] = [];
  const trialEnds: UpcomingSubscription[] = [];
  const cancellations: UpcomingSubscription[] = [];
  for (const row of upcomingRows) {
    if (!row.currentPeriodEnd) continue;
    const item = { name: row.name, seatLimit: row.seatLimit, currentPeriodEnd: row.currentPeriodEnd };
    if (row.billingStatus === "trialing") trialEnds.push(item);
    else if (row.cancelAtPeriodEnd) cancellations.push(item);
    else renewals.push(item);
  }

  return {
    locale,
    periodStart: isoDate(thisMonday),
    lastWeekLabel: dateRangeLabel(locale, lastMonday, new Date(thisMonday.getTime() - DAY_MS)),
    thisWeekLabel: dateRangeLabel(locale, thisMonday, new Date(nextMonday.getTime() - DAY_MS)),
    lastWeek: {
      newAccounts,
      newOrganisations,
      invitesAccepted: orgInvitesAccepted + boardInvitesAccepted,
      boardsCreated,
      subscriptionsStarted,
      seatsPurchased: seatsPurchased(seatEmailRows),
    },
    snapshot: {
      activeAccounts,
      activeOrganisations,
      activeBoards,
      paidOrganisations,
      trialOrganisations,
      purchasedSeats: Number(purchasedSeatsRow[0]?.count ?? 0),
    },
    upcoming: {
      renewals: groupUpcoming(locale, renewals),
      trialEnds: groupUpcoming(locale, trialEnds),
      cancellations: groupUpcoming(locale, cancellations),
    },
    adminUrl,
  };
}

export function mondayUtc(now: Date): Date {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const daysSinceMonday = (start.getUTCDay() + 6) % 7;
  start.setUTCDate(start.getUTCDate() - daysSinceMonday);
  return start;
}

export function startWeeklyAdminRecapScheduler(deps: WeeklyAdminRecapDeps): () => Promise<void> {
  const scheduler = startSweepScheduler({
    name: "weekly-admin-recap",
    task: () => runWeeklyAdminRecapSweep(deps),
    nextDelayMs: SWEEP_INTERVAL_MS,
    log: deps.log,
  });
  return () => scheduler.stop();
}

function seatsPurchased(rows: Array<{ type: string; data: unknown; createdAt: Date }>): number {
  const unique = new Map<string, { type: string; data: BillingEmailQueueData }>();
  for (const row of rows) {
    const data = row.data as BillingEmailQueueData;
    const key = `${row.type}:${data.clientId}:${data.dedupeKey ?? row.createdAt.toISOString()}`;
    unique.set(key, { type: row.type, data });
  }
  let total = 0;
  for (const { type, data } of unique.values()) {
    const current = data.purchasedSeatCount ?? data.activeSeatCount ?? 0;
    total += type === "seat_billed" ? Math.max(0, current - (data.previousPurchasedSeatCount ?? 0)) : current;
  }
  return total;
}

function groupUpcoming(locale: Locale, rows: UpcomingSubscription[]): WeeklyAdminRecapUpcomingGroup[] {
  const groups = new Map<string, UpcomingSubscription[]>();
  for (const row of rows) {
    const date = isoDate(row.currentPeriodEnd);
    groups.set(date, [...(groups.get(date) ?? []), row]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, items]) => {
    const names = items.map((item) => item.name).sort((a, b) => a.localeCompare(b));
    return {
      dateLabel: recapDate(locale, new Date(`${date}T00:00:00.000Z`)),
      organisationCount: items.length,
      seatCount: items.reduce((sum, item) => sum + item.seatLimit, 0),
      organisations: names.length <= 5
        ? names
        : [...names.slice(0, 5), serverMessages(locale).email.weeklyAdminRecap.moreOrganisations({ count: names.length - 5 })],
    };
  });
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function recapDate(locale: Locale, date: Date): string {
  return formatDate(locale, date, { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
}

function dateRangeLabel(locale: Locale, start: Date, end: Date): string {
  return serverMessages(locale).email.weeklyAdminRecap.dateRange({ start: recapDate(locale, start), end: recapDate(locale, end) });
}
