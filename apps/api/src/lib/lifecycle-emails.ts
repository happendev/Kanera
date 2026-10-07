import {
  activityEvents,
  automations,
  boardInvitations,
  boardMembers,
  boards,
  clientMembers,
  clients,
  inviteTokens,
  lifecycleEmailSends,
  notificationSettings,
  users,
  workspaceAnalyticsMilestones,
  workspaces,
  type LifecycleEmailKind,
  type LifecycleEmailQueueData,
  type LifecycleEmailQueueType,
  type LifecycleNextStep,
} from "@kanera/shared/schema";
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "../db.js";
import { env } from "../env.js";
import type { Mailer } from "./mailer.js";
import { startSweepScheduler } from "./sweep-scheduler.js";

/**
 * Hosted lifecycle emails from the marketing lifecycle-communication plan. Registration and trial
 * moments are sent elsewhere (signup and trial-expiry); this sweep owns the moments that are only
 * visible over time: no board yet, board but no team, early success, inactivity, and an active-team
 * check-in.
 *
 * Privacy boundary: every decision below reads structure only (row counts, milestone timestamps,
 * presence and activity times). Nothing reads card, comment, or board text, and nothing scores or
 * labels the customer. Organisations flagged analyticsExcluded (staff, demo, seed, load-test) are
 * skipped so internal accounts never receive customer marketing.
 */

const DAY_MS = 86_400_000;
const SWEEP_INTERVAL_MS = 60 * 60_000;
// Per-sweep cap per kind keeps a first deploy against a large backlog from flooding SMTP in one tick;
// the remainder is picked up by later sweeps while still inside its window.
const CANDIDATES_PER_KIND = 200;
// Never send two lifecycle emails to the same organisation within this gap, so moments that become
// true on the same day (for example a first board and early success) arrive as a sequence.
const MIN_GAP_DAYS = 3;
// After an inactivity email, wait this long before another, even if the organisation came back and
// went quiet again in between.
const INACTIVE_REPEAT_DAYS = 90;

const KIND_TO_QUEUE_TYPE: Record<LifecycleEmailKind, LifecycleEmailQueueType> = {
  no_board: "lifecycle_no_board",
  invite_team: "lifecycle_invite_team",
  early_success: "lifecycle_early_success",
  inactive: "lifecycle_inactive",
  active_checkin: "lifecycle_active_checkin",
};

type Candidate = {
  clientId: string;
  orgName: string;
  dedupeKey: string;
  ctaPath: string;
  nextStep?: LifecycleNextStep | null;
  onFreePlan?: boolean | null;
};

export async function runLifecycleEmailSweep(mailer: Mailer, log?: FastifyBaseLogger, now = new Date()): Promise<number> {
  if (env.KANERA_DEPLOYMENT_MODE !== "hosted") return 0;
  let sent = 0;
  // Ordered by lifecycle stage. Because each claim feeds the MIN_GAP_DAYS check, an organisation
  // that qualifies for two moments in the same sweep gets only the earlier-stage one.
  sent += await sendKind(mailer, "no_board", await noBoardCandidates(now), log);
  sent += await sendKind(mailer, "invite_team", await inviteTeamCandidates(now), log);
  sent += await sendKind(mailer, "early_success", await earlySuccessCandidates(now), log);
  sent += await sendKind(mailer, "inactive", await inactiveCandidates(now), log);
  sent += await sendKind(mailer, "active_checkin", await activeCheckinCandidates(now), log);
  return sent;
}

async function sendKind(mailer: Mailer, kind: LifecycleEmailKind, candidates: Candidate[], log?: FastifyBaseLogger): Promise<number> {
  let sent = 0;
  for (const candidate of candidates) {
    // Claim before queueing: the unique index makes this the idempotency boundary across restarts
    // and overlapping workers. A crash after the claim loses one optional email, never duplicates it.
    const claimed = await db.insert(lifecycleEmailSends)
      .values({ clientId: candidate.clientId, kind, dedupeKey: candidate.dedupeKey })
      .onConflictDoNothing()
      .returning({ id: lifecycleEmailSends.id });
    if (claimed.length === 0) continue;

    for (const recipient of await lifecycleRecipients(candidate.clientId)) {
      const data: LifecycleEmailQueueData = {
        displayName: recipient.displayName,
        orgName: candidate.orgName,
        ctaUrl: `${env.WEB_ORIGIN}${candidate.ctaPath}`,
        unsubscribeUrl: lifecycleUnsubscribeUrl(recipient.userId),
        nextStep: candidate.nextStep ?? null,
        onFreePlan: candidate.onFreePlan ?? null,
        feedbackEmail: env.LIFECYCLE_FEEDBACK_EMAIL,
      };
      await mailer.sendLifecycle(recipient.email, KIND_TO_QUEUE_TYPE[kind], data);
      sent += 1;
    }
  }
  if (sent > 0) log?.info({ kind, sent }, "queued lifecycle emails");
  return sent;
}

/**
 * Lifecycle mail goes to active owners only: they made the setup decisions these emails are about.
 * A user who turned off email entirely, or turned off lifecycle email, is skipped. Users with no
 * settings row get the defaults (both on).
 */
async function lifecycleRecipients(clientId: string): Promise<Array<{ userId: string; email: string; displayName: string }>> {
  return db
    .select({ userId: users.id, email: users.email, displayName: users.displayName })
    .from(clientMembers)
    .innerJoin(users, eq(users.id, clientMembers.userId))
    .leftJoin(notificationSettings, eq(notificationSettings.userId, users.id))
    .where(and(
      eq(clientMembers.clientId, clientId),
      eq(clientMembers.clientRole, "owner"),
      isNull(clientMembers.suspendedAt),
      isNull(clientMembers.removedAt),
      isNull(users.deletedAt),
      sql`coalesce(${notificationSettings.emailEnabled}, true)`,
      sql`coalesce(${notificationSettings.lifecycleEmail}, true)`,
    ));
}

function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

// Candidate queries are raw SQL with explicit aliases: they are correlated subqueries over clients,
// and Drizzle drops table qualifiers on single-table selects, which makes columns such as "id"
// ambiguous inside the subqueries. Interpolating ${table} still binds the real table names.

type ClientRow = { clientId: string; orgName: string };

/** Shared organisation filter: a live, self-signed-up customer org with no recent lifecycle email. */
function eligibleClient(now: Date): SQL {
  return sql`c.deleted_at is null
    and c.suspended_at is null
    and c.permanent_deletion_requested_at is null
    and c.analytics_excluded = false
    -- Orgs provisioned by an operator (no creating user) are not part of the self-serve lifecycle.
    and c.created_by_user_id is not null
    and not exists (
      select 1 from ${lifecycleEmailSends} les
      where les.client_id = c.id and les.created_at > ${daysAgo(now, MIN_GAP_DAYS)}
    )`;
}

function notYetSent(kind: LifecycleEmailKind): SQL {
  return sql`not exists (select 1 from ${lifecycleEmailSends} les where les.client_id = c.id and les.kind = ${kind})`;
}

// Most recent customer activity in the organisation: either a recorded action (users, API keys, MCP)
// or a member's last realtime session. Presence alone matters for read-only use, which writes no
// activity rows.
const lastActivityAt = sql`greatest(
  (select max(ae.created_at) from ${activityEvents} ae where ae.client_id = c.id),
  (select max(u.last_online_at) from ${clientMembers} cm
     inner join ${users} u on u.id = cm.user_id
     where cm.client_id = c.id and cm.removed_at is null)
)`;

async function selectClients<T extends ClientRow>(columns: SQL, where: SQL): Promise<T[]> {
  const result = await db.execute<T>(sql`
    select c.id as "clientId", c.name as "orgName"${columns}
    from ${clients} c
    where ${where}
    order by c.created_at
    limit ${CANDIDATES_PER_KIND}
  `);
  return result.rows as T[];
}

/** "No board created": two days in with nothing set up. Remove setup uncertainty. */
async function noBoardCandidates(now: Date): Promise<Candidate[]> {
  const rows = await selectClients(sql``, sql`${eligibleClient(now)}
    and ${notYetSent("no_board")}
    and c.created_at <= ${daysAgo(now, 2)} and c.created_at > ${daysAgo(now, 14)}
    and not exists (
      select 1 from ${boards} b inner join ${workspaces} w on w.id = b.workspace_id where w.client_id = c.id
    )
    -- A board-invite guest's signup creates a silent home org they never meant to set up. If the
    -- creator is a guest on another organisation's board, do not nudge them to build their own.
    and not exists (
      select 1 from ${boardMembers} bm
      inner join ${boards} b on b.id = bm.board_id
      inner join ${workspaces} w on w.id = b.workspace_id
      where bm.user_id = c.created_by_user_id and w.client_id <> c.id
    )`);
  return rows.map((row) => ({ ...row, dedupeKey: "once", ctaPath: "/" }));
}

/** "Board created, no invite": a live board for a day, still a team of one, never invited anyone. */
async function inviteTeamCandidates(now: Date): Promise<Candidate[]> {
  const rows = await selectClients(sql``, sql`${eligibleClient(now)}
    and ${notYetSent("invite_team")}
    and c.created_at <= ${daysAgo(now, 3)} and c.created_at > ${daysAgo(now, 21)}
    and exists (
      select 1 from ${boards} b inner join ${workspaces} w on w.id = b.workspace_id
      where w.client_id = c.id and b.archived_at is null and w.archived_at is null
        and b.created_at <= ${daysAgo(now, 1)}
    )
    and (
      select count(*) from ${clientMembers} cm
      where cm.client_id = c.id and cm.removed_at is null and cm.suspended_at is null
    ) = 1
    and not exists (select 1 from ${inviteTokens} it where it.client_id = c.id)
    and not exists (select 1 from ${boardInvitations} bi where bi.client_id = c.id)`);
  return rows.map((row) => ({ ...row, dedupeKey: "once", ctaPath: "/settings/users" }));
}

/**
 * "Early success": a workspace crossed the meaningful-work milestone (three real cards) at least a
 * day ago. Introduce exactly one next workflow: automations if the org has none, otherwise My Cards.
 */
async function earlySuccessCandidates(now: Date): Promise<Candidate[]> {
  const rows = await selectClients<ClientRow & { workspaceId: string | null; hasAutomations: boolean }>(sql`,
    (
      select w.id from ${workspaces} w
      inner join ${workspaceAnalyticsMilestones} m on m.workspace_id = w.id
      where w.client_id = c.id and w.kind = 'standard' and w.archived_at is null
        and m.meaningful_work_created_at is not null
      order by m.meaningful_work_created_at
      limit 1
    ) as "workspaceId",
    exists (
      select 1 from ${automations} a inner join ${workspaces} w on w.id = a.workspace_id
      where w.client_id = c.id
    ) as "hasAutomations"`, sql`${eligibleClient(now)}
    and ${notYetSent("early_success")}
    and exists (
      select 1 from ${workspaceAnalyticsMilestones} m
      inner join ${workspaces} w on w.id = m.workspace_id
      where w.client_id = c.id
        and m.meaningful_work_created_at <= ${daysAgo(now, 1)}
        and m.meaningful_work_created_at > ${daysAgo(now, 14)}
    )`);
  return rows.map((row) => {
    // Automations live in standard-workspace settings; an org whose only milestone is on a
    // standalone board gets My Cards rather than a settings link that would not resolve.
    const nextStep: LifecycleNextStep = !row.hasAutomations && row.workspaceId ? "automations" : "my_cards";
    return {
      clientId: row.clientId,
      orgName: row.orgName,
      dedupeKey: "once",
      nextStep,
      ctaPath: nextStep === "automations" ? `/w/${row.workspaceId}/settings/automations` : "/my-cards",
    };
  });
}

/**
 * "Inactive account": the organisation was used, then went quiet for two weeks. One email per
 * quiet episode (keyed on the last-activity date), and at most one per INACTIVE_REPEAT_DAYS. Episodes
 * older than 60 days are left alone rather than mailing long-abandoned accounts.
 */
async function inactiveCandidates(now: Date): Promise<Candidate[]> {
  const rows = await selectClients<ClientRow & { lastActivityAt: string | Date }>(sql`, ${lastActivityAt} as "lastActivityAt"`, sql`${eligibleClient(now)}
    and c.created_at <= ${daysAgo(now, 14)}
    and ${lastActivityAt} <= ${daysAgo(now, 14)} and ${lastActivityAt} > ${daysAgo(now, 60)}
    and not exists (
      select 1 from ${lifecycleEmailSends} les
      where les.client_id = c.id and les.kind = 'inactive' and les.created_at > ${daysAgo(now, INACTIVE_REPEAT_DAYS)}
    )`);
  return rows.map((row) => ({
    clientId: row.clientId,
    orgName: row.orgName,
    dedupeKey: `since:${new Date(row.lastActivityAt).toISOString().slice(0, 10)}`,
    ctaPath: "/",
  }));
}

/**
 * "Active customer": a team (collaboration started three weeks ago, or a paid subscription) that is
 * still active this week, and at least 30 days in. Sent once: educate, ask for feedback, and mention
 * expansion that fits the plan.
 */
async function activeCheckinCandidates(now: Date): Promise<Candidate[]> {
  const rows = await selectClients<ClientRow & { plan: string }>(sql`, c.plan as "plan"`, sql`${eligibleClient(now)}
    and ${notYetSent("active_checkin")}
    and c.created_at <= ${daysAgo(now, 30)}
    and (
      c.billing_status = 'active'
      or exists (
        select 1 from ${workspaceAnalyticsMilestones} m
        inner join ${workspaces} w on w.id = m.workspace_id
        where w.client_id = c.id and m.collaboration_started_at <= ${daysAgo(now, 21)}
      )
    )
    and ${lastActivityAt} > ${daysAgo(now, 7)}`);
  return rows.map((row) => ({
    clientId: row.clientId,
    orgName: row.orgName,
    dedupeKey: "once",
    onFreePlan: row.plan === "free",
    ctaPath: "/team-cards",
  }));
}

export function startLifecycleEmailScheduler(log: FastifyBaseLogger, mailer: Mailer): () => Promise<void> {
  return startSweepScheduler({
    name: "lifecycle-emails",
    task: () => runLifecycleEmailSweep(mailer, log),
    nextDelayMs: SWEEP_INTERVAL_MS,
    // Let a fresh deploy settle before the first sweep rather than mailing during a rolling restart.
    runImmediately: false,
    firstDelayMs: 5 * 60_000,
    log,
  }).stop;
}

// Unsubscribe tokens never expire: an old email's link must keep working. They are HMACs over the
// user id with a purpose prefix, so they cannot be confused with any other signed value derived
// from JWT_SECRET, and they only authorise turning lifecycle email off for that one user.
const UNSUBSCRIBE_PURPOSE = "kanera:lifecycle-unsubscribe:v1:";

function unsubscribeSignature(userId: string): string {
  return createHmac("sha256", env.JWT_SECRET).update(`${UNSUBSCRIBE_PURPOSE}${userId}`).digest("base64url");
}

export function lifecycleUnsubscribeToken(userId: string): string {
  return `${userId}.${unsubscribeSignature(userId)}`;
}

function lifecycleUnsubscribeUrl(userId: string): string {
  return `${env.WEB_ORIGIN}/email/unsubscribe?token=${encodeURIComponent(lifecycleUnsubscribeToken(userId))}`;
}

export function verifyLifecycleUnsubscribeToken(token: string): string | null {
  const [userId, signature, extra] = token.split(".");
  if (!userId || !signature || extra !== undefined) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) return null;
  const expected = Buffer.from(unsubscribeSignature(userId));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return userId;
}

// Exported for the import routes, which also skip users who turned email off.
export async function userAcceptsEmail(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ emailEnabled: notificationSettings.emailEnabled })
    .from(notificationSettings)
    .where(eq(notificationSettings.userId, userId))
    .limit(1);
  return row?.emailEnabled ?? true;
}
