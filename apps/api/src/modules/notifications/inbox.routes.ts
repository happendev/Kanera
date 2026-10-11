import { dto } from "@kanera/shared";
import type { NotificationInboxItem, NotificationInboxPage, NotificationRow } from "@kanera/shared/dto";
import { summariseActivityChange } from "@kanera/shared/activity-summary";
import { activityEvents, cards, notifications } from "@kanera/shared/schema";
import { and, asc, desc, eq, gt, inArray, isNotNull, lte, or, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { loadAccessibleBoards } from "../../lib/accessible-boards.js";
import { agentActorName } from "../../lib/agent-actor-name.js";
import { badRequest, forbidden } from "../../lib/errors.js";
import { assertAgentAccessAllowed } from "../../lib/mcp-policy.js";
import { enrichNotifications, inboxVisibleNotificationCondition } from "../../lib/notifications.js";
import { absoluteCardUrl } from "../../lib/wire-card.js";

// Notification rows are written by asynchronous fanout in several processes, so a row can commit a
// moment after a later-stamped one. Reading only rows older than this keeps a forward cursor from
// stepping past one that has not committed yet; agents polling every few seconds or minutes never
// notice the lag.
const SETTLE_MS = 5_000;
const COMMENT_EXCERPT_MAX = 1_000;
// Postgres keeps microseconds but a cursor carries a JS Date's milliseconds, so comparing the raw
// column would hand back the cursor's own row on the next poll. Page on the truncated value instead.
const createdAtMs = sql<Date>`date_trunc('milliseconds', ${notifications.createdAt})`.mapWith(notifications.createdAt);

function encodeCursor(row: { createdAt: Date; id: string }): string {
  return `${row.createdAt.toISOString()}|${row.id}`;
}

function decodeCursor(raw: string): { createdAt: Date; id: string } {
  const sep = raw.indexOf("|");
  const createdAt = new Date(sep === -1 ? raw : raw.slice(0, sep));
  if (Number.isNaN(createdAt.getTime())) throw badRequest("since must be a cursor returned by a previous call");
  // An empty id sorts before every uuid, so a timestamp-only cursor includes rows at that instant.
  return { createdAt, id: sep === -1 ? "" : raw.slice(sep + 1) };
}

function commentExcerpt(body: string | null): string | null {
  if (!body) return null;
  const text = body.trim();
  return text.length <= COMMENT_EXCERPT_MAX ? text : `${text.slice(0, COMMENT_EXCERPT_MAX - 1).trimEnd()}…`;
}

function toInboxItem(row: NotificationRow, auth: AuthClaims): NotificationInboxItem {
  const activity = row.activity;
  const change = summariseActivityChange(row);
  const detail = change.value ? `${change.text} ${change.value}` : change.text;
  const agentName = activity?.actorKind === "agent" ? activity.agentName ?? null : null;
  const actorName = row.actorName && agentName !== null ? agentActorName(row.actorName, agentName) : row.actorName;
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    reason: row.reason,
    read: row.readAt !== null,
    // Overdue and reminder rows have no actor; they read as a bare statement ("card is overdue").
    summary: activity && actorName ? `${actorName} ${detail}` : detail,
    action: activity?.action ?? null,
    actor: activity
      ? {
          userId: activity.actorId ?? null,
          name: row.actorName,
          kind: activity.actorKind,
          agentName,
          self: Boolean(auth.agentGrantId) && activity.agentGrantId === auth.agentGrantId,
        }
      : null,
    card: row.cardId && row.cardKey && row.organisationKey && row.cardTitle !== null
      ? { id: row.cardId, key: row.cardKey, title: row.cardTitle, url: absoluteCardUrl(row.organisationKey, row.cardKey) }
      : null,
    board: row.boardId ? { id: row.boardId, name: row.boardName } : null,
    commentExcerpt: commentExcerpt(row.commentBody),
  };
}

/**
 * The connected user's notification inbox as a forward feed, for agents on a local machine that can
 * neither receive webhooks nor hold a realtime socket. It is the same rows the web inbox shows (so
 * replies and mentions on cards the owner watches, which includes cards their agent created), read
 * oldest first from a cursor. Public API only: the web app pages its drawer newest first.
 */
export async function notificationInboxRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/notifications", async (req): Promise<NotificationInboxPage> => {
    // The inbox belongs to a person; a workspace key only borrows its creator's id.
    if (req.auth.authKind === "apiKey" && req.auth.apiKeyKind !== "personal") {
      throw forbidden("the notification inbox needs a personal API key or OAuth connection");
    }
    assertAgentAccessAllowed(req.auth);
    const query = dto.notificationInboxQuery.parse(req.query ?? {});
    const since = query.since ? decodeCursor(query.since) : null;
    const settledBefore = new Date(Date.now() - SETTLE_MS);

    // Scope to boards this credential can read now. That drops organisations whose AI agent access is
    // off and any board the owner has since lost, on top of the inbox's own visibility rules.
    const boardIds = (await loadAccessibleBoards(req.auth)).map((board) => board.id);
    if (boardIds.length === 0) {
      return { items: [], cursor: query.since ?? encodeCursor({ createdAt: settledBefore, id: "" }), hasMore: false };
    }

    const conditions: SQL[] = [
      eq(notifications.userId, req.auth.sub),
      isNotNull(notifications.boardId),
      inArray(notifications.boardId, boardIds),
      lte(createdAtMs, settledBefore),
      inboxVisibleNotificationCondition(),
    ];
    // By default an agent does not read back its own writes. Only an OAuth agent grant can be told
    // apart from its owner; a plain personal key acts as the person, whose own actions never notify.
    if (!query.includeSelf && req.auth.agentGrantId) {
      conditions.push(sql`${activityEvents.agentGrantId} is distinct from ${req.auth.agentGrantId}`);
    }
    if (since) {
      conditions.push(or(
        gt(createdAtMs, since.createdAt),
        and(eq(createdAtMs, since.createdAt), gt(notifications.id, since.id)),
      )!);
    }

    // Without a cursor the first poll returns the latest rows as a baseline; after that it reads
    // forward. Both come back oldest first so the last item is always the newest.
    const order = since
      ? [asc(createdAtMs), asc(notifications.id)]
      : [desc(createdAtMs), desc(notifications.id)];
    const rows = await db
      .select({ id: notifications.id, createdAt: createdAtMs })
      .from(notifications)
      .leftJoin(activityEvents, eq(activityEvents.id, notifications.activityId))
      .leftJoin(cards, eq(cards.id, notifications.cardId))
      .where(and(...conditions))
      .orderBy(...order)
      .limit(query.limit + 1);
    const hasMore = since !== null && rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    if (!since) page.reverse();

    const enriched = new Map((await enrichNotifications(db, page.map((row) => row.id))).map((row) => [row.id, row]));
    const items = page
      .map((row) => enriched.get(row.id))
      .filter((row): row is NotificationRow => row !== undefined)
      .map((row) => toInboxItem(row, req.auth));
    const last = page.at(-1);
    return {
      items,
      // An empty first poll still hands back a cursor so the next one only sees what is new.
      cursor: last ? encodeCursor(last) : query.since ?? encodeCursor({ createdAt: settledBefore, id: "" }),
      hasMore,
    };
  });
}
