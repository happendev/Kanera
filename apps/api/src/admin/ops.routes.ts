import { dto } from "@kanera/shared";
import {
  cardAttachments,
  clients,
  emailQueue,
  EMAIL_QUEUE_STATUS,
  eventOutbox,
  noteAttachments,
  users,
  webhookDeliveries,
  type EmailQueueStatus,
} from "@kanera/shared/schema";
import { and, asc, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { db } from "../db.js";
import { badRequest, notFound } from "../lib/errors.js";
import { writeAdminAudit } from "./audit.js";

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

// email_queue.status is numeric; map the human-facing names to their codes for filtering.
const EMAIL_STATUS_BY_NAME: Record<string, EmailQueueStatus> = {
  queued: EMAIL_QUEUE_STATUS.queued,
  success: EMAIL_QUEUE_STATUS.success,
  error: EMAIL_QUEUE_STATUS.error,
  immediate: EMAIL_QUEUE_STATUS.immediate,
};
const WEBHOOK_STATUSES = ["queued", "delivering", "success", "failed"] as const;

async function auditQueue(req: FastifyRequest, action: string, queue: string, id: string) {
  await db.transaction(async (tx) => {
    await writeAdminAudit(tx, {
      adminUserId: req.adminAuth.sub,
      action,
      targetType: "queue",
      details: { queue, id },
    });
  });
}

export async function adminOpsRoutes(app: FastifyInstance) {
  // Grouped health snapshot across the three durable queues plus org/user totals. Read-only.
  app.get("/ops/health", async (req) => {
    const { days } = dto.adminHealthQuery.parse(req.query);
    const emailRows = await db
      .select({ status: emailQueue.status, count: sql<number>`count(*)::int` })
      .from(emailQueue)
      .groupBy(emailQueue.status);
    const webhookRows = await db
      .select({ status: webhookDeliveries.status, count: sql<number>`count(*)::int` })
      .from(webhookDeliveries)
      .groupBy(webhookDeliveries.status);
    // Outbox has no status column — a row is "pending" until BOTH realtime + webhook fanout complete.
    const [outboxPendingRow] = await db
      .select({ outboxPending: sql<number>`count(*)::int` })
      .from(eventOutbox)
      .where(or(eq(eventOutbox.realtimeDispatched, false), eq(eventOutbox.webhooksEnqueued, false)));
    const outboxPending = outboxPendingRow?.outboxPending ?? 0;
    const [outboxTotalRow] = await db.select({ outboxTotal: sql<number>`count(*)::int` }).from(eventOutbox);
    const outboxTotal = outboxTotalRow?.outboxTotal ?? 0;

    const emptyTotals = { total: 0, suspended: 0, deleted: 0 };
    const [orgTotals = emptyTotals] = await db
      .select({
        total: sql<number>`count(*)::int`,
        suspended: sql<number>`count(*) filter (where ${clients.suspendedAt} is not null)::int`,
        deleted: sql<number>`count(*) filter (where ${clients.deletedAt} is not null)::int`,
      })
      .from(clients);
    const [userTotals = emptyTotals] = await db
      .select({
        total: sql<number>`count(*)::int`,
        suspended: sql<number>`count(*) filter (where ${users.suspendedAt} is not null)::int`,
        deleted: sql<number>`count(*) filter (where ${users.deletedAt} is not null)::int`,
      })
      .from(users);
    const [planUsers = { free: 0, trial: 0, pro: 0 }] = await db
      .select({
        // Trialing is a paid entitlement tier, but the portal splits it out so growth/conversion is visible.
        free: sql<number>`count(*) filter (where ${clients.plan} = 'free')::int`,
        trial: sql<number>`count(*) filter (where ${clients.plan} = 'paid' and ${clients.billingStatus} = 'trialing')::int`,
        pro: sql<number>`count(*) filter (where ${clients.plan} = 'paid' and ${clients.billingStatus} in ('active', 'past_due'))::int`,
      })
      .from(users)
      .innerJoin(clients, eq(users.clientId, clients.id))
      .where(and(isNull(users.deletedAt), isNull(users.removedAt), isNull(clients.deletedAt)));

    // Keep the dashboard total aligned with tenant quota accounting: both card and note attachments
    // consume storage, while derived cover images are not separate attachment rows.
    const [cardStorage] = await db
      .select({ bytes: sql<string>`coalesce(sum(${cardAttachments.byteSize}), 0)::bigint` })
      .from(cardAttachments);
    const [noteStorage] = await db
      .select({ bytes: sql<string>`coalesce(sum(${noteAttachments.byteSize}), 0)::bigint` })
      .from(noteAttachments);
    const storageUsedBytes = Number(cardStorage?.bytes ?? 0) + Number(noteStorage?.bytes ?? 0);

    type TrendRow = { date: string; activeUsers: number; registrations: number; cards: number; boards: number; automationEffectful: number; automationNoop: number; automationFailed: number };
    // Generate the calendar first so quiet days remain visible instead of disappearing from the chart.
    // Active users reflects the latest presence timestamp we retain; historical sessions are not stored.
    const trendRows = await db.execute<TrendRow>(sql`
      with days as (
        select generate_series(current_date - (${days - 1} * interval '1 day'), current_date, interval '1 day')::date as day
      )
      select
        to_char(days.day, 'YYYY-MM-DD') as date,
        (select count(*)::int from "user" u where u.last_online_at >= days.day and u.last_online_at < days.day + interval '1 day') as "activeUsers",
        (select count(*)::int from "user" u where u.created_at >= days.day and u.created_at < days.day + interval '1 day') as registrations,
        (select count(*)::int from card c where c.created_at >= days.day and c.created_at < days.day + interval '1 day') as cards,
        (select count(*)::int from board b where b.created_at >= days.day and b.created_at < days.day + interval '1 day') as boards,
        (select count(*)::int from automation_run ar where ar.outcome = 'effectful' and ar.ran_at >= days.day and ar.ran_at < days.day + interval '1 day') as "automationEffectful",
        (select count(*)::int from automation_run ar where ar.outcome = 'noop' and ar.ran_at >= days.day and ar.ran_at < days.day + interval '1 day') as "automationNoop",
        (select count(*)::int from automation_run ar where ar.outcome = 'failed' and ar.ran_at >= days.day and ar.ran_at < days.day + interval '1 day') as "automationFailed"
      from days
      order by days.day
    `);

    const emailByName = Object.fromEntries(
      Object.entries(EMAIL_STATUS_BY_NAME).map(([name, code]) => [name, emailRows.find((r) => r.status === code)?.count ?? 0]),
    );
    const webhookByName = Object.fromEntries(
      WEBHOOK_STATUSES.map((name) => [name, webhookRows.find((r) => r.status === name)?.count ?? 0]),
    );

    return {
      emailQueue: emailByName,
      webhookDeliveries: webhookByName,
      eventOutbox: { pending: outboxPending, dispatched: outboxTotal - outboxPending, total: outboxTotal },
      orgs: orgTotals,
      users: userTotals,
      planUsers,
      storageUsedBytes,
      trends: trendRows.rows,
    };
  });

  // --- email queue ---
  app.get("/ops/email-queue", async (req) => {
    const query = dto.adminQueueFilterQuery.parse(req.query);
    const code = query.status ? EMAIL_STATUS_BY_NAME[query.status] : undefined;
    if (query.status && code === undefined) throw badRequest("invalid status");
    const where = and(code !== undefined ? eq(emailQueue.status, code) : undefined, query.q ? or(ilike(emailQueue.toEmail, `%${query.q}%`), ilike(emailQueue.type, `%${query.q}%`), ilike(emailQueue.lastError, `%${query.q}%`)) : undefined);
    const [countRow] = await db.select({ total: sql<number>`count(*)::int` }).from(emailQueue).where(where);
    const emailSort = { primary: emailQueue.toEmail, status: emailQueue.status, attempts: emailQueue.retries, lastError: emailQueue.lastError, createdAt: emailQueue.createdAt } as const;
    const order = query.direction === "asc" ? asc : desc;

    const rows = await db
      .select({
        id: emailQueue.id,
        toEmail: emailQueue.toEmail,
        subject: emailQueue.subject,
        type: emailQueue.type,
        status: emailQueue.status,
        retries: emailQueue.retries,
        nextAttemptAt: emailQueue.nextAttemptAt,
        lastError: emailQueue.lastError,
        sentAt: emailQueue.sentAt,
        createdAt: emailQueue.createdAt,
      })
      .from(emailQueue)
      .where(where)
      .orderBy(order(emailSort[query.sort]), asc(emailQueue.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    return { items: rows.map((r) => ({ ...r, nextAttemptAt: iso(r.nextAttemptAt), sentAt: iso(r.sentAt), createdAt: iso(r.createdAt) })), total: countRow?.total ?? 0, page: query.page, pageSize: query.pageSize };
  });

  app.post("/ops/email-queue/:id/retry", async (req) => {
    const { id } = req.params as { id: string };
    const [current] = await db.select({ status: emailQueue.status }).from(emailQueue).where(eq(emailQueue.id, id)).limit(1);
    if (!current) throw notFound("email not found");
    if (current.status !== EMAIL_QUEUE_STATUS.error) throw badRequest("only failed emails can be retried");
    // Reset to queued with a fresh retry budget and due now, so the main API email sweeper re-claims it
    // (it selects status=queued AND retries<MAX AND nextAttemptAt<=now). We do NOT process it here.
    const res = await db
      .update(emailQueue)
      .set({ status: EMAIL_QUEUE_STATUS.queued, retries: 0, nextAttemptAt: new Date(), lastError: null, updatedAt: new Date() })
      .where(eq(emailQueue.id, id))
      .returning({ id: emailQueue.id });
    if (!res.length) throw notFound("email not found");
    await auditQueue(req, "queue.email.retry", "email_queue", id);
    return { ok: true };
  });

  app.post("/ops/email-queue/:id/cancel", async (req) => {
    const { id } = req.params as { id: string };
    const [current] = await db.select({ status: emailQueue.status }).from(emailQueue).where(eq(emailQueue.id, id)).limit(1);
    if (!current) throw notFound("email not found");
    if (current.status !== EMAIL_QUEUE_STATUS.queued && current.status !== EMAIL_QUEUE_STATUS.immediate) throw badRequest("only pending emails can be cancelled");
    // Mark terminal (error) so the sweeper never claims it. There is no dedicated "cancelled" code.
    const res = await db
      .update(emailQueue)
      .set({ status: EMAIL_QUEUE_STATUS.error, lastError: "cancelled by admin", updatedAt: new Date() })
      .where(eq(emailQueue.id, id))
      .returning({ id: emailQueue.id });
    if (!res.length) throw notFound("email not found");
    await auditQueue(req, "queue.email.cancel", "email_queue", id);
    return { ok: true };
  });

  // --- webhook deliveries ---
  app.get("/ops/webhook-deliveries", async (req) => {
    const query = dto.adminQueueFilterQuery.parse(req.query);
    if (query.status && !WEBHOOK_STATUSES.includes(query.status as (typeof WEBHOOK_STATUSES)[number])) throw badRequest("invalid status");
    const where = and(query.status ? eq(webhookDeliveries.status, query.status as (typeof WEBHOOK_STATUSES)[number]) : undefined, query.q ? or(ilike(webhookDeliveries.eventType, `%${query.q}%`), ilike(webhookDeliveries.lastError, `%${query.q}%`)) : undefined);
    const [countRow] = await db.select({ total: sql<number>`count(*)::int` }).from(webhookDeliveries).where(where);
    const webhookSort = { primary: webhookDeliveries.eventType, status: webhookDeliveries.status, attempts: webhookDeliveries.attempts, lastError: webhookDeliveries.lastError, createdAt: webhookDeliveries.createdAt } as const;
    const order = query.direction === "asc" ? asc : desc;

    const rows = await db
      .select({
        id: webhookDeliveries.id,
        endpointId: webhookDeliveries.endpointId,
        workspaceId: webhookDeliveries.workspaceId,
        eventType: webhookDeliveries.eventType,
        status: webhookDeliveries.status,
        attempts: webhookDeliveries.attempts,
        nextAttemptAt: webhookDeliveries.nextAttemptAt,
        responseStatus: webhookDeliveries.responseStatus,
        lastError: webhookDeliveries.lastError,
        deliveredAt: webhookDeliveries.deliveredAt,
        createdAt: webhookDeliveries.createdAt,
      })
      .from(webhookDeliveries)
      .where(where)
      .orderBy(order(webhookSort[query.sort]), asc(webhookDeliveries.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    return { items: rows.map((r) => ({ ...r, nextAttemptAt: iso(r.nextAttemptAt), deliveredAt: iso(r.deliveredAt), createdAt: iso(r.createdAt) })), total: countRow?.total ?? 0, page: query.page, pageSize: query.pageSize };
  });

  app.post("/ops/webhook-deliveries/:id/retry", async (req) => {
    const { id } = req.params as { id: string };
    const [current] = await db.select({ status: webhookDeliveries.status }).from(webhookDeliveries).where(eq(webhookDeliveries.id, id)).limit(1);
    if (!current) throw notFound("delivery not found");
    if (current.status !== "failed") throw badRequest("only failed webhook deliveries can be retried");
    // Requeue with a fresh attempt budget, due now; the main API webhook sweeper re-claims queued rows.
    const res = await db
      .update(webhookDeliveries)
      .set({ status: "queued", attempts: 0, nextAttemptAt: new Date(), lastError: null, updatedAt: new Date() })
      .where(eq(webhookDeliveries.id, id))
      .returning({ id: webhookDeliveries.id });
    if (!res.length) throw notFound("delivery not found");
    await auditQueue(req, "queue.webhook.retry", "webhook_deliveries", id);
    return { ok: true };
  });

  app.post("/ops/webhook-deliveries/:id/cancel", async (req) => {
    const { id } = req.params as { id: string };
    const [current] = await db.select({ status: webhookDeliveries.status }).from(webhookDeliveries).where(eq(webhookDeliveries.id, id)).limit(1);
    if (!current) throw notFound("delivery not found");
    if (current.status !== "queued" && current.status !== "delivering") throw badRequest("only pending webhook deliveries can be cancelled");
    const res = await db
      .update(webhookDeliveries)
      .set({ status: "failed", lastError: "cancelled by admin", updatedAt: new Date() })
      .where(eq(webhookDeliveries.id, id))
      .returning({ id: webhookDeliveries.id });
    if (!res.length) throw notFound("delivery not found");
    await auditQueue(req, "queue.webhook.cancel", "webhook_deliveries", id);
    return { ok: true };
  });

  // --- event outbox ---
  app.get("/ops/event-outbox", async (req) => {
    const query = dto.adminQueueFilterQuery.parse(req.query);
    let statusWhere;
    if (query.status === "pending") statusWhere = or(eq(eventOutbox.realtimeDispatched, false), eq(eventOutbox.webhooksEnqueued, false));
    else if (query.status === "dispatched") statusWhere = and(eq(eventOutbox.realtimeDispatched, true), eq(eventOutbox.webhooksEnqueued, true));
    else if (query.status) throw badRequest("invalid status (expected pending|dispatched)");
    const where = and(statusWhere, query.q ? or(ilike(eventOutbox.eventType, `%${query.q}%`), ilike(eventOutbox.scope, `%${query.q}%`), ilike(eventOutbox.lastError, `%${query.q}%`)) : undefined);
    const [countRow] = await db.select({ total: sql<number>`count(*)::int` }).from(eventOutbox).where(where);
    const outboxStatus = sql`case when ${eventOutbox.realtimeDispatched} and ${eventOutbox.webhooksEnqueued} then 1 else 0 end`;
    const outboxSort = { primary: eventOutbox.eventType, status: outboxStatus, attempts: eventOutbox.attempts, lastError: eventOutbox.lastError, createdAt: eventOutbox.createdAt } as const;
    const order = query.direction === "asc" ? asc : desc;

    const rows = await db
      .select({
        id: eventOutbox.id,
        scope: eventOutbox.scope,
        eventType: eventOutbox.eventType,
        workspaceId: eventOutbox.workspaceId,
        boardId: eventOutbox.boardId,
        realtimeDispatched: eventOutbox.realtimeDispatched,
        webhooksEnqueued: eventOutbox.webhooksEnqueued,
        attempts: eventOutbox.attempts,
        lastError: eventOutbox.lastError,
        processingLeaseExpiresAt: eventOutbox.processingLeaseExpiresAt,
        createdAt: eventOutbox.createdAt,
      })
      .from(eventOutbox)
      .where(where)
      .orderBy(order(outboxSort[query.sort]), asc(eventOutbox.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    return { items: rows.map((r) => ({ ...r, processingLeaseExpiresAt: iso(r.processingLeaseExpiresAt), createdAt: iso(r.createdAt) })), total: countRow?.total ?? 0, page: query.page, pageSize: query.pageSize };
  });

  app.post("/ops/event-outbox/:id/retry", async (req) => {
    const { id } = req.params as { id: string };
    const [current] = await db.select({ realtimeDispatched: eventOutbox.realtimeDispatched, webhooksEnqueued: eventOutbox.webhooksEnqueued }).from(eventOutbox).where(eq(eventOutbox.id, id)).limit(1);
    if (!current) throw notFound("outbox event not found");
    if (current.realtimeDispatched && current.webhooksEnqueued) throw badRequest("only pending outbox events can be retried");
    // Clear the processing lease so the main API outbox dispatcher immediately re-claims it (it selects
    // rows whose lease is null or expired and which are not yet fully dispatched).
    const res = await db
      .update(eventOutbox)
      .set({ processingLeaseExpiresAt: null, lastError: null, updatedAt: new Date() })
      .where(eq(eventOutbox.id, id))
      .returning({ id: eventOutbox.id });
    if (!res.length) throw notFound("outbox event not found");
    await auditQueue(req, "queue.outbox.retry", "event_outbox", id);
    return { ok: true };
  });

  app.post("/ops/event-outbox/:id/cancel", async (req) => {
    const { id } = req.params as { id: string };
    const [current] = await db.select({ realtimeDispatched: eventOutbox.realtimeDispatched, webhooksEnqueued: eventOutbox.webhooksEnqueued }).from(eventOutbox).where(eq(eventOutbox.id, id)).limit(1);
    if (!current) throw notFound("outbox event not found");
    if (current.realtimeDispatched && current.webhooksEnqueued) throw badRequest("only pending outbox events can be cancelled");
    // Mark terminal by flagging both fanout paths done, so the dispatcher stops claiming it. This drops
    // the event (it will not be delivered) — used to clear a poison row.
    const res = await db
      .update(eventOutbox)
      .set({ realtimeDispatched: true, webhooksEnqueued: true, lastError: "cancelled by admin", processingLeaseExpiresAt: null, updatedAt: new Date() })
      .where(eq(eventOutbox.id, id))
      .returning({ id: eventOutbox.id });
    if (!res.length) throw notFound("outbox event not found");
    await auditQueue(req, "queue.outbox.cancel", "event_outbox", id);
    return { ok: true };
  });
}
