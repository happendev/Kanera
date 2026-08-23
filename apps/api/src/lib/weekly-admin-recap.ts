import {
  activityEvents,
  boardInvitations,
  boards,
  clients,
  EMAIL_QUEUE_STATUS,
  emailQueue,
  users,
  type BillingEmailQueueData,
  type WeeklyAdminRecapEmailQueueData,
  type WeeklyAdminRecapUpcomingGroup,
} from "@kanera/shared/schema";
import { and, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db.js";
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
  const data = await buildWeeklyAdminRecap(deps.db, lastMonday, thisMonday, nextMonday, deps.adminUrl);
  const [queued] = await deps.db
    .insert(emailQueue)
    .values({
      toEmail: deps.adminEmail,
      subject: emailSubject(`Kanera weekly recap · ${data.lastWeekLabel}`),
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

export async function buildWeeklyAdminRecap(
  database: Db,
  lastMonday: Date,
  thisMonday: Date,
  nextMonday: Date,
  adminUrl: string,
): Promise<WeeklyAdminRecapEmailQueueData> {
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
    countRows(database.select({ count: sql<number>`count(*)` }).from(users).where(and(gte(users.createdAt, lastMonday), lt(users.createdAt, thisMonday)))),
    countRows(database.select({ count: sql<number>`count(*)` }).from(clients).where(and(gte(clients.createdAt, lastMonday), lt(clients.createdAt, thisMonday)))),
    countRows(database.select({ count: sql<number>`count(*)` }).from(boards).where(and(gte(boards.createdAt, lastMonday), lt(boards.createdAt, thisMonday)))),
    countRows(database.select({ count: sql<number>`count(*)` }).from(activityEvents).where(and(
      eq(activityEvents.entityType, "workspaceMember"),
      eq(activityEvents.action, "added"),
      sql`${activityEvents.payload}->>'inviteId' is not null`,
      gte(activityEvents.createdAt, lastMonday),
      lt(activityEvents.createdAt, thisMonday),
    ))),
    countRows(database.select({ count: sql<number>`count(*)` }).from(boardInvitations).where(and(
      gte(boardInvitations.acceptedAt, lastMonday),
      lt(boardInvitations.acceptedAt, thisMonday),
    ))),
    countRows(database.select({ count: sql<number>`count(*)` }).from(clients).where(and(
      gte(clients.analyticsSubscriptionStartedAt, lastMonday),
      lt(clients.analyticsSubscriptionStartedAt, thisMonday),
    ))),
    countRows(database.select({ count: sql<number>`count(*)` }).from(users).where(isNull(users.deletedAt))),
    countRows(database.select({ count: sql<number>`count(*)` }).from(clients).where(isNull(clients.deletedAt))),
    countRows(database.select({ count: sql<number>`count(*)` }).from(boards).where(isNull(boards.archivedAt))),
    countRows(database.select({ count: sql<number>`count(*)` }).from(clients).where(and(
      isNull(clients.deletedAt),
      inArray(clients.billingStatus, ["active", "past_due"]),
    ))),
    countRows(database.select({ count: sql<number>`count(*)` }).from(clients).where(and(
      isNull(clients.deletedAt),
      eq(clients.billingStatus, "trialing"),
    ))),
    database.select({ count: sql<number>`coalesce(sum(${clients.seatLimit}), 0)` }).from(clients).where(and(
      isNull(clients.deletedAt),
      inArray(clients.billingStatus, ["active", "past_due"]),
    )),
    database.select({ type: emailQueue.type, data: emailQueue.data, createdAt: emailQueue.createdAt }).from(emailQueue).where(and(
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
    periodStart: isoDate(thisMonday),
    lastWeekLabel: dateRangeLabel(lastMonday, new Date(thisMonday.getTime() - DAY_MS)),
    thisWeekLabel: dateRangeLabel(thisMonday, new Date(nextMonday.getTime() - DAY_MS)),
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
      renewals: groupUpcoming(renewals),
      trialEnds: groupUpcoming(trialEnds),
      cancellations: groupUpcoming(cancellations),
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

function groupUpcoming(rows: UpcomingSubscription[]): WeeklyAdminRecapUpcomingGroup[] {
  const groups = new Map<string, UpcomingSubscription[]>();
  for (const row of rows) {
    const date = isoDate(row.currentPeriodEnd);
    groups.set(date, [...(groups.get(date) ?? []), row]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, items]) => {
    const names = items.map((item) => item.name).sort((a, b) => a.localeCompare(b));
    return {
      dateLabel: formatDate(new Date(`${date}T00:00:00.000Z`)),
      organisationCount: items.length,
      seatCount: items.reduce((sum, item) => sum + item.seatLimit, 0),
      organisations: names.length <= 5 ? names : [...names.slice(0, 5), `+${names.length - 5} more`],
    };
  });
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }).format(date);
}

function dateRangeLabel(start: Date, end: Date): string {
  return `${formatDate(start)}–${formatDate(end)}`;
}
