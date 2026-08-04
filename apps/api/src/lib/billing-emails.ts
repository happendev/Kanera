import {
  automations,
  boardInvitations,
  boardMembers,
  boards,
  clientMembers,
  clients,
  emailQueue,
  planActions,
  users,
  webhookEndpoints,
  workspaceApiKeys,
  workspaces,
  type BillingEmailQueueData,
  type BillingImpactSummary,
  type BillingLimitsSummary,
  type EmailQueueType,
} from "@kanera/shared/schema";
import { and, asc, eq, inArray, isNull, notExists, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { db, type Db } from "../db.js";
import { env, type Env } from "../env.js";
import { canAddPaidSeat, isPaidTier } from "./entitlements.js";
import type { Mailer } from "./mailer.js";

type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
type BillingEmailKind =
  | "pro_trial_started"
  | "pro_trial_warning"
  | "downgraded_to_free"
  | "upgraded_to_pro"
  | "welcome_to_pro"
  | "billing_changed"
  | "billing_renewed"
  | "billing_payment_failed"
  | "billing_payment_recovered"
  | "seat_billed"
  | "seat_capacity_reduced"
  | "pro_cancellation_scheduled"
  | "pro_cancellation_reversed"
  | "pro_cancelled";

type BillingEmailEnv = Pick<
  Env,
  | "KANERA_DEPLOYMENT_MODE"
  | "WEB_ORIGIN"
  | "HOSTED_FREE_MAX_BOARDS"
  | "HOSTED_FREE_MAX_ORG_MEMBERS"
  | "HOSTED_FREE_MAX_ENABLED_AUTOMATIONS"
  | "HOSTED_FREE_MAX_AUTOMATION_EXECUTIONS_MONTHLY"
>;

export type BillingEmailContext = {
  clientId: string;
  kind: BillingEmailKind;
  daysRemaining?: number | null;
  trialEndsAt?: Date | null;
  impact?: BillingImpactSummary | null;
  billingSummary?: string | null;
  billingInterval?: "monthly" | "annual" | null;
  purchasedSeatCount?: number | null;
  previousPurchasedSeatCount?: number | null;
  periodEnd?: Date | null;
  seatKind?: "member" | "guest" | null;
  billedUserEmail?: string | null;
  billedUserName?: string | null;
  activeSeatCount?: number | null;
  dedupeKey?: string | null;
};

export type SeatCapacityEmailContext = {
  clientId: string;
  previousSeatLimit: number;
  seatLimit: number;
  dedupeKey: string;
};

// Sent when an admin changes purchased capacity. The pre-purchased pool model has no per-assignment
// charge, so these messages describe the explicit pool change, not a specific member or guest.
export async function sendHostedSeatCapacityEmail(
  mailer: Mailer,
  context: SeatCapacityEmailContext,
  options: { log?: FastifyBaseLogger; tx?: Tx; config?: BillingEmailEnv } = {},
): Promise<number> {
  const config = options.config ?? env;
  if (config.KANERA_DEPLOYMENT_MODE !== "hosted") return 0;
  const database = options.tx ?? db;
  const [client] = await database
    .select({
      billingStatus: clients.billingStatus,
      stripeSubscriptionItemId: clients.stripeSubscriptionItemId,
    })
    .from(clients)
    .where(eq(clients.id, context.clientId))
    .limit(1);
  const increased = context.seatLimit > context.previousSeatLimit;
  if (!client?.stripeSubscriptionItemId || (increased ? !canAddPaidSeat(client.billingStatus) : !isPaidTier(client.billingStatus))) return 0;
  return sendHostedBillingEmail(mailer, {
    clientId: context.clientId,
    kind: increased ? "seat_billed" : "seat_capacity_reduced",
    activeSeatCount: context.seatLimit,
    purchasedSeatCount: context.seatLimit,
    previousPurchasedSeatCount: context.previousSeatLimit,
    billingSummary: increased ? seatCapacitySummary() : null,
    dedupeKey: context.dedupeKey,
    impact: null,
  }, options);
}

export async function sendHostedBillingEmail(
  mailer: Mailer,
  context: BillingEmailContext,
  options: { log?: FastifyBaseLogger; tx?: Tx; config?: BillingEmailEnv } = {},
): Promise<number> {
  const config = options.config ?? env;
  if (config.KANERA_DEPLOYMENT_MODE !== "hosted") return 0;
  const database = options.tx ?? db;

  const [client] = await database
    .select({ id: clients.id, name: clients.name })
    .from(clients)
    .where(eq(clients.id, context.clientId))
    .limit(1);
  if (!client) return 0;

  const recipients = await database
    .select({ email: users.email, displayName: users.displayName })
    .from(clientMembers)
    .innerJoin(users, eq(users.id, clientMembers.userId))
    .where(and(
      eq(clientMembers.clientId, context.clientId),
      inArray(clientMembers.clientRole, ["owner", "admin"]),
      isNull(clientMembers.suspendedAt),
      isNull(clientMembers.removedAt),
      isNull(users.deletedAt),
    ));
  if (recipients.length === 0) return 0;

  const impact = context.impact === undefined ? await previewDowngradeImpact(context.clientId, database, config) : context.impact;
  const paramsBase: Omit<BillingEmailQueueData, "displayName"> = {
    clientId: context.clientId,
    dedupeKey: context.dedupeKey ?? null,
    orgName: client.name,
    settingsUrl: `${config.WEB_ORIGIN}/settings/account-plan`,
    trialEndsAtLabel: context.trialEndsAt ? formatDate(context.trialEndsAt) : null,
    daysRemaining: context.daysRemaining ?? null,
    impact: impact ?? null,
    limits: freeLimits(config),
    billingSummary: context.billingSummary ?? null,
    billingInterval: context.billingInterval ?? null,
    purchasedSeatCount: context.purchasedSeatCount ?? null,
    previousPurchasedSeatCount: context.previousPurchasedSeatCount ?? null,
    periodEndLabel: context.periodEnd ? formatDate(context.periodEnd) : null,
    seatKind: context.seatKind ?? null,
    billedUserEmail: context.billedUserEmail ?? null,
    billedUserName: context.billedUserName ?? null,
    activeSeatCount: context.activeSeatCount ?? null,
  };

  let sent = 0;
  for (const recipient of recipients) {
    if (context.dedupeKey && await hasBillingEmail(recipient.email, context.kind, context.clientId, context.dedupeKey, database)) {
      continue;
    }
    const params = { ...paramsBase, displayName: recipient.displayName };
    await sendByKind(mailer, context.kind, recipient.email, params);
    sent += 1;
  }
  if (sent > 0) options.log?.info({ clientId: context.clientId, kind: context.kind, sent }, "queued hosted billing emails");
  return sent;
}

export async function previewDowngradeImpact(
  clientId: string,
  database: Tx = db,
  config: BillingEmailEnv = env,
): Promise<BillingImpactSummary> {
  const impact = emptyImpact();

  const enabledAutomations = await database
    .select({ id: automations.id })
    .from(automations)
    .innerJoin(workspaces, eq(workspaces.id, automations.workspaceId))
    .where(and(eq(workspaces.clientId, clientId), eq(automations.enabled, true)))
    .orderBy(asc(automations.createdAt));
  impact.automationsDisabled = Math.max(0, enabledAutomations.length - config.HOSTED_FREE_MAX_ENABLED_AUTOMATIONS);

  const enabledWebhooks = await database
    .select({ id: webhookEndpoints.id })
    .from(webhookEndpoints)
    .innerJoin(workspaces, eq(workspaces.id, webhookEndpoints.workspaceId))
    .where(and(eq(workspaces.clientId, clientId), eq(webhookEndpoints.enabled, true)));
  impact.webhooksDisabled = enabledWebhooks.length;

  // Count both workspace keys (via workspace's client) and personal keys (via owner's client), so the
  // downgrade-impact preview matches what the conversion actually revokes.
  const activeWorkspaceApiKeys = await database
    .select({ id: workspaceApiKeys.id })
    .from(workspaceApiKeys)
    .innerJoin(workspaces, eq(workspaces.id, workspaceApiKeys.workspaceId))
    .where(and(eq(workspaces.clientId, clientId), isNull(workspaceApiKeys.revokedAt)));
  const activePersonalApiKeys = await database
    .select({ id: workspaceApiKeys.id })
    .from(workspaceApiKeys)
    .where(and(eq(workspaceApiKeys.kind, "personal"), eq(workspaceApiKeys.clientId, clientId), isNull(workspaceApiKeys.revokedAt)));
  impact.apiKeysRevoked = activeWorkspaceApiKeys.length + activePersonalApiKeys.length;

  const guestMembers = await database
    .selectDistinct({ userId: boardMembers.userId })
    .from(boardMembers)
    .innerJoin(boards, eq(boards.id, boardMembers.boardId))
    .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
    .innerJoin(users, eq(users.id, boardMembers.userId))
    .where(and(
      eq(workspaces.clientId, clientId),
      notExists(database.select({ userId: clientMembers.userId }).from(clientMembers).where(and(
        eq(clientMembers.clientId, clientId),
        eq(clientMembers.userId, users.id),
      ))),
    ));
  // The email reports people affected, not board-membership rows: one guest can lose access to many
  // boards during the same downgrade and must still appear as one guest in the summary.
  impact.guestMembersRemoved = guestMembers.length;

  const pendingInvites = await database
    .select({ id: boardInvitations.id })
    .from(boardInvitations)
    .innerJoin(boards, eq(boards.id, boardInvitations.boardId))
    .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
    .where(
      and(
        eq(workspaces.clientId, clientId),
        isNull(boardInvitations.acceptedAt),
        isNull(boardInvitations.revokedAt),
        sql`not exists (
          select 1 from ${users}
          inner join ${clientMembers}
            on ${clientMembers.userId} = ${users.id}
           and ${clientMembers.clientId} = ${clientId}
           and ${clientMembers.suspendedAt} is null
           and ${clientMembers.removedAt} is null
          where ${users.email} = ${boardInvitations.email}
            and ${users.deletedAt} is null
        )`,
      ),
    );
  impact.guestInvitesRevoked = pendingInvites.length;

  // Workspaces are unlimited on Free; only boards are capped, and that cap is org-wide.
  const liveBoards = await database
    .select({ id: boards.id })
    .from(boards)
    .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId))
    .where(and(eq(workspaces.clientId, clientId), isNull(workspaces.archivedAt), isNull(boards.archivedAt)))
    .orderBy(asc(boards.createdAt));
  impact.boardsArchived += Math.max(0, liveBoards.length - config.HOSTED_FREE_MAX_BOARDS);

  const members = await database
    .select({ id: clientMembers.userId, role: clientMembers.clientRole, createdAt: clientMembers.addedAt })
    .from(clientMembers)
    .where(and(eq(clientMembers.clientId, clientId), isNull(clientMembers.suspendedAt), isNull(clientMembers.removedAt)))
    .orderBy(asc(clientMembers.addedAt));
  const owners = members.filter((m) => m.role === "owner");
  const protectedOwnerId = owners[0]?.id ?? null;
  const candidates = members.filter((m) => m.id !== protectedOwnerId);
  impact.usersSuspended = Math.max(0, candidates.length - Math.max(0, config.HOSTED_FREE_MAX_ORG_MEMBERS - (protectedOwnerId ? 1 : 0)));

  return impact;
}

export async function impactFromPlanActions(clientId: string, database: Tx = db): Promise<BillingImpactSummary> {
  const actions = await database.select({ kind: planActions.kind, payload: planActions.payload }).from(planActions).where(eq(planActions.clientId, clientId));
  const impact = emptyImpact();
  const removedGuestIds = new Set<string>();
  for (const action of actions) {
    if (action.kind === "board_archived") impact.boardsArchived += 1;
    else if (action.kind === "user_suspended") impact.usersSuspended += 1;
    else if (action.kind === "automation_disabled") impact.automationsDisabled += 1;
    else if (action.kind === "webhook_disabled") impact.webhooksDisabled += 1;
    else if (action.kind === "api_key_revoked") impact.apiKeysRevoked += 1;
    else if (action.kind === "guest_member_removed") removedGuestIds.add((action.payload as { userId: string }).userId);
    else if (action.kind === "guest_invitation_revoked") impact.guestInvitesRevoked += 1;
  }
  // A plan action is stored per board so access can be restored precisely, while the customer-facing
  // impact summary counts each affected guest only once.
  impact.guestMembersRemoved = removedGuestIds.size;
  return impact;
}

function sendByKind(mailer: Mailer, kind: BillingEmailKind, to: string, params: BillingEmailQueueData) {
  switch (kind) {
    case "pro_trial_started":
      return mailer.sendProTrialStarted(to, params);
    case "pro_trial_warning":
      return mailer.sendProTrialWarning(to, params);
    case "downgraded_to_free":
      return mailer.sendDowngradedToFree(to, params);
    case "upgraded_to_pro":
      return mailer.sendUpgradedToPro(to, params);
    case "welcome_to_pro":
      return mailer.sendWelcomeToPro(to, params);
    case "billing_changed":
      return mailer.sendBillingChanged(to, params);
    case "billing_renewed":
      return mailer.sendBillingRenewed(to, params);
    case "billing_payment_failed":
      return mailer.sendBillingPaymentFailed(to, params);
    case "billing_payment_recovered":
      return mailer.sendBillingPaymentRecovered(to, params);
    case "seat_billed":
      return mailer.sendSeatBilled(to, params);
    case "seat_capacity_reduced":
      return mailer.sendSeatCapacityReduced(to, params);
    case "pro_cancellation_scheduled":
      return mailer.sendProCancellationScheduled(to, params);
    case "pro_cancellation_reversed":
      return mailer.sendProCancellationReversed(to, params);
    case "pro_cancelled":
      return mailer.sendProCancelled(to, params);
  }
}

async function hasBillingEmail(toEmail: string, type: EmailQueueType, clientId: string, dedupeKey: string, database: Tx): Promise<boolean> {
  const [existing] = await database
    .select({ id: emailQueue.id })
    .from(emailQueue)
    .where(and(
      eq(emailQueue.toEmail, toEmail),
      eq(emailQueue.type, type),
      sql`${emailQueue.data}->>'clientId' = ${clientId}`,
      sql`${emailQueue.data}->>'dedupeKey' = ${dedupeKey}`,
    ))
    .limit(1);
  return existing !== undefined;
}

function freeLimits(config: BillingEmailEnv): BillingLimitsSummary {
  return {
    maxBoards: config.HOSTED_FREE_MAX_BOARDS,
    maxOrgMembers: config.HOSTED_FREE_MAX_ORG_MEMBERS,
    maxEnabledAutomations: config.HOSTED_FREE_MAX_ENABLED_AUTOMATIONS,
    maxAutomationExecutionsPerMonth: config.HOSTED_FREE_MAX_AUTOMATION_EXECUTIONS_MONTHLY,
  };
}

function emptyImpact(): BillingImpactSummary {
  return {
    boardsArchived: 0,
    usersSuspended: 0,
    automationsDisabled: 0,
    webhooksDisabled: 0,
    apiKeysRevoked: 0,
    guestMembersRemoved: 0,
    guestInvitesRevoked: 0,
  };
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(date);
}

function seatCapacitySummary(): string {
  return "The new capacity is available now and can be assigned to a member or guest.";
}
