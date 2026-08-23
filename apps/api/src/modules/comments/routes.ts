import { dto } from "@kanera/shared";
import {
  activityEvents,
  cardAttachments,
  cards,
  commentReactions,
  comments,
  externalLinks,
  users,
} from "@kanera/shared/schema";
import { and, asc, desc, eq, getTableColumns, gt, inArray, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { assertBatchCardVisibility, assertBoardAccess, assertCardAccess } from "../../lib/access.js";
import { recordActivity } from "../../lib/activity.js";
import { evaluateWorkspaceAnalyticsMilestones } from "../../lib/analytics-milestones.js";
import { enqueueCommentAddedEmails, enqueueCommentMentionedNotifications } from "../../lib/assignee-email-notifications.js";
import { touchCardActivity } from "../../lib/card-activity.js";
import { fetchReactionsByComment } from "../../lib/comment-reactions.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { externalEmbeddedMediaReferences, signedAvatarUrl, signEmbeddedMediaUrls, stripSignedEmbeddedMediaUrls, unsignedMediaUrl, withSignedMedia } from "../../lib/media-keys.js";
import { replaceCardMentions } from "../../lib/mentions.js";
import { queueNotificationFanout } from "../../lib/notifications.js";
import { emitToBoard } from "../../realtime/emit.js";

async function linkAttachmentsToComment(params: {
  clientId: string;
  attachmentIds: string[];
  cardId: string;
  boardId: string;
  commentId: string;
  userId: string;
}) {
  const { clientId, attachmentIds, cardId, boardId, commentId, userId } = params;
  if (attachmentIds.length === 0) return;
  const updated = await db
    .update(cardAttachments)
    .set({ commentId, source: "comment" })
    .where(
      and(
        inArray(cardAttachments.id, attachmentIds),
        eq(cardAttachments.cardId, cardId),
        eq(cardAttachments.uploadedById, userId),
        isNull(cardAttachments.commentId),
      ),
    )
    .returning({ id: cardAttachments.id });
  if (updated.length === 0) return;
  const rows = await db
    .select({
      id: cardAttachments.id,
      cardId: cardAttachments.cardId,
      fileName: cardAttachments.fileName,
      mimeType: cardAttachments.mimeType,
      byteSize: cardAttachments.byteSize,
      url: cardAttachments.url,
      fileKey: cardAttachments.fileKey,
      thumbnailUrl: cardAttachments.thumbnailUrl,
      thumbnailFileKey: cardAttachments.thumbnailFileKey,
      createdAt: cardAttachments.createdAt,
      uploadedById: cardAttachments.uploadedById,
      uploadedByName: users.displayName,
      uploadedByAvatarUrl: users.avatarUrl,
      uploadedByClientId: users.clientId,
      source: cardAttachments.source,
      commentId: cardAttachments.commentId,
    })
    .from(cardAttachments)
    .innerJoin(users, eq(users.id, cardAttachments.uploadedById))
    .where(inArray(cardAttachments.id, updated.map((u) => u.id)));
  for (const { uploadedByClientId, uploadedByAvatarUrl, ...row } of rows) {
    // Re-emit as created so clients upsert the row with the new commentId/source.
    emitToBoard(boardId, "card:attachment:created", {
      boardId,
      cardId,
      attachment: withSignedMedia(clientId, {
        ...row,
        uploadedByAvatarUrl: signedAvatarUrl(uploadedByClientId, uploadedByAvatarUrl),
        url: unsignedMediaUrl(clientId, row.fileKey)!,
        thumbnailUrl: unsignedMediaUrl(clientId, row.thumbnailFileKey),
      }),
    });
  }
}

function assertCardActive(card: Pick<typeof cards.$inferSelect, "archivedAt">) {
  if (card.archivedAt) throw badRequest("archived cards are read-only");
}

function cardFeedSortPriority(item: dto.CardFeedItem): number {
  return item.type === "activity" && item.data.entityType === "card" && item.data.action === "created" ? 0 : 1;
}

function compareCardFeedItems(a: dto.CardFeedItem, b: dto.CardFeedItem): number {
  const ta = new Date(a.data.createdAt as unknown as string).getTime();
  const tb = new Date(b.data.createdAt as unknown as string).getTime();
  if (ta !== tb) return tb - ta;
  const priority = cardFeedSortPriority(a) - cardFeedSortPriority(b);
  if (priority !== 0) return priority;
  return String(a.data.id).localeCompare(String(b.data.id));
}

type CommentCursor = { kind: "cardComments"; createdAt: string; id: string };
type CardFeedCursor = { kind: "cardFeed"; createdAt: string; priority: number; id: string };

function encodeCursor(cursor: CommentCursor | CardFeedCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodedCursor(raw: string | undefined): CommentCursor | CardFeedCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as {
      kind?: unknown;
      createdAt?: unknown;
      id?: unknown;
      priority?: unknown;
    };
    if (
      (parsed.kind !== "cardComments" && parsed.kind !== "cardFeed")
      || typeof parsed.createdAt !== "string"
      || !Number.isFinite(new Date(parsed.createdAt).getTime())
      || typeof parsed.id !== "string"
      || !/^[0-9a-f-]{36}$/i.test(parsed.id)
      || (parsed.kind === "cardFeed" && parsed.priority !== 0 && parsed.priority !== 1)
    ) throw new Error();
    return parsed as CommentCursor | CardFeedCursor;
  } catch {
    // Preserve cursors issued by older clients while making every newly issued cursor lossless.
    if (Number.isFinite(new Date(raw).getTime())) return { kind: "cardComments", createdAt: raw, id: "ffffffff-ffff-ffff-ffff-ffffffffffff" };
    throw badRequest("invalid card feed cursor");
  }
}

function commentCursor(raw: string | undefined): CommentCursor | null {
  const cursor = decodedCursor(raw);
  if (!cursor) return null;
  if (cursor.kind !== "cardComments") throw badRequest("cursor does not belong to card comments");
  return cursor;
}

function cardFeedCursor(raw: string | undefined): CardFeedCursor | null {
  const cursor = decodedCursor(raw);
  if (!cursor) return null;
  if (cursor.kind === "cardFeed") return cursor;
  // A legacy timestamp cursor means strictly before that instant for every feed item.
  return { kind: "cardFeed", createdAt: cursor.createdAt, priority: 1, id: cursor.id };
}

function commentAfterCursor(cursor: CommentCursor, createdAt = comments.createdAt, id = comments.id): SQL {
  const at = new Date(cursor.createdAt);
  return or(lt(createdAt, at), and(eq(createdAt, at), gt(id, cursor.id)))!;
}

function feedAfterCursor(
  cursor: CardFeedCursor,
  createdAt: typeof comments.createdAt | typeof activityEvents.createdAt,
  id: typeof comments.id | typeof activityEvents.id,
  priority: SQL<number>,
): SQL {
  const at = new Date(cursor.createdAt);
  return or(
    lt(createdAt, at),
    and(eq(createdAt, at), or(
      gt(priority, cursor.priority),
      and(eq(priority, cursor.priority), gt(id, cursor.id)),
    )),
  )!;
}

function assertIntegrationEmbeddedMediaStoredLocally(markdown: string, clientId: string, authKind?: string) {
  if (authKind !== "apiKey") return;
  const externalRefs = externalEmbeddedMediaReferences(markdown, clientId);
  if (externalRefs.length > 0) {
    throw badRequest("inline media from integrations must be uploaded to Kanera before embedding");
  }
}

function commentAttribution(auth: { authKind?: string; apiKeyKind?: string; apiKeyId?: string; apiKeyName?: string }) {
  // Personal credentials act as their owning user. In particular, personal OAuth uses a synthetic
  // apiKeyId solely as a stable rate-limit key, so it must never reach the UUID FK on comment rows.
  if (auth.authKind !== "apiKey" || auth.apiKeyKind === "personal") {
    return { authorKind: "user" as const, apiKeyId: null, apiKeyName: null };
  }
  return {
    authorKind: "apiKey" as const,
    apiKeyId: auth.apiKeyId ?? null,
    apiKeyName: auth.apiKeyName ?? "API key",
  };
}

function canMutateComment(
  comment: { authorId: string; authorKind: string; apiKeyId: string | null },
  auth: { sub: string; authKind?: string; apiKeyId?: string },
) {
  if (comment.authorKind === "user") return comment.authorId === auth.sub;
  return comment.authorKind === "apiKey"
    && auth.authKind === "apiKey"
    && comment.apiKeyId !== null
    && comment.apiKeyId === auth.apiKeyId;
}

async function selectCommentRow(commentId: string, clientId: string): Promise<dto.CommentRow> {
  const rows = await selectCommentRows([commentId], clientId);
  const comment = rows[0];
  if (!comment) throw notFound();
  return comment;
}

async function mirrorIdsByCommentId(commentIds: string[]): Promise<Map<string, string>> {
  if (commentIds.length === 0) return new Map();
  const [links, mirrorCommentActivities] = await Promise.all([
    db
      .select({ commentId: externalLinks.entityId, provider: externalLinks.provider })
      .from(externalLinks)
      .where(and(
        eq(externalLinks.entityType, "comment"),
        eq(externalLinks.externalType, "comment"),
        inArray(externalLinks.entityId, commentIds),
        sql`${externalLinks.provider} like 'mirror:%'`,
      )),
    // Initial provenance and source-archive comments are destination-owned notes rather than
    // externally linked source comments. Their durable activity payload carries the mirror id,
    // including for cards created before CommentRow exposed mirror provenance.
    db
      .select({
        commentId: activityEvents.entityId,
        mirrorId: sql<string | null>`${activityEvents.payload}->>'mirrorId'`,
      })
      .from(activityEvents)
      .where(and(
        eq(activityEvents.entityType, "comment"),
        inArray(activityEvents.entityId, commentIds),
        sql`${activityEvents.payload}->>'mirrorId' is not null`,
      )),
  ]);
  const result = new Map(links.flatMap((link) => {
    const mirrorId = link.provider.slice("mirror:".length);
    return mirrorId ? [[link.commentId, mirrorId] as const] : [];
  }));
  for (const row of mirrorCommentActivities) {
    if (row.mirrorId) result.set(row.commentId, row.mirrorId);
  }
  return result;
}

async function selectCommentRows(commentIds: string[], clientId: string): Promise<dto.CommentRow[]> {
  if (commentIds.length === 0) return [];
  const rows = await db
    .select({
      id: comments.id,
      cardId: comments.cardId,
      authorId: comments.authorId,
      authorKind: comments.authorKind,
      apiKeyId: comments.apiKeyId,
      apiKeyName: comments.apiKeyName,
      authorName: sql<string>`case when ${comments.authorKind} = 'system' then 'Kanera' when ${comments.authorKind} = 'apiKey' then coalesce(${comments.apiKeyName}, 'API key') else ${users.displayName} end`,
      authorAvatarUrl: sql<string | null>`case when ${comments.authorKind} in ('system', 'apiKey') then null else ${users.avatarUrl} end`,
      authorClientId: users.clientId,
      body: comments.body,
      editedAt: comments.editedAt,
      createdAt: comments.createdAt,
    })
    .from(comments)
    .innerJoin(users, eq(users.id, comments.authorId))
    .where(inArray(comments.id, commentIds));
  const [reactionsMap, mirrorIds] = await Promise.all([
    fetchReactionsByComment(commentIds),
    mirrorIdsByCommentId(commentIds),
  ]);
  const byId = new Map(rows.map((row) => [row.id, signedCommentRow({ ...row, mirrorId: mirrorIds.get(row.id) ?? null }, reactionsMap.get(row.id) ?? [], clientId)]));
  return commentIds.flatMap((commentId) => {
    const row = byId.get(commentId);
    return row ? [row] : [];
  });
}

function signedCommentRow(
  comment: Omit<dto.CommentRow, "reactions"> & { authorClientId: string },
  reactions: dto.CommentRow["reactions"],
  clientId: string,
): dto.CommentRow {
  const { authorClientId, ...wireComment } = comment;
  return {
    ...wireComment,
    authorAvatarUrl: signedAvatarUrl(authorClientId, comment.authorAvatarUrl),
    body: signEmbeddedMediaUrls(comment.body, clientId) ?? comment.body,
    reactions,
  };
}

export async function commentRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/cards/:id/feed", async (req) => {
    const { id: cardId } = req.params as { id: string };
    const query = dto.listCardFeedQuery.parse(req.query ?? {});
    const limit = query.limit;
    const cursor = cardFeedCursor(query.cursor);
    const [card] = await db.select().from(cards).where(eq(cards.id, cardId)).limit(1);
    if (!card) throw notFound();
    // The row is already in hand; passing it skips a redundant re-read of its board_id.
    await assertCardAccess(req.auth, card);

    const commentConditions = [eq(comments.cardId, cardId)];
    const commentPriority = sql<number>`1`;
    if (cursor) commentConditions.push(feedAfterCursor(cursor, comments.createdAt, comments.id, commentPriority));

    const activityConditions = [
      eq(activityEvents.boardId, card.boardId),
      // Comments already appear as rich feed rows. Exclude their audit rows before applying the
      // source limit so a burst of comments cannot hide older card activity or end pagination early.
      ne(activityEvents.entityType, "comment"),
      // Keep collapsed/no-op bursts out of the card detail feed while the
      // underlying activity row remains available to the audit trail.
      eq(activityEvents.feedVisible, true),
      or(
        and(eq(activityEvents.entityType, "card"), eq(activityEvents.entityId, cardId)),
        sql`${activityEvents.payload}->>'cardId' = ${cardId}`,
      )!,
    ];
    const activityPriority = sql<number>`case when ${activityEvents.entityType} = 'card' and ${activityEvents.action} = 'created' then 0 else 1 end`;
    if (cursor) activityConditions.push(feedAfterCursor(cursor, activityEvents.createdAt, activityEvents.id, activityPriority));

    const [commentRows, activityRows] = await Promise.all([
      db
        .select({
          id: comments.id,
          cardId: comments.cardId,
          authorId: comments.authorId,
          authorKind: comments.authorKind,
          apiKeyId: comments.apiKeyId,
          apiKeyName: comments.apiKeyName,
          authorName: sql<string>`case when ${comments.authorKind} = 'system' then 'Kanera' when ${comments.authorKind} = 'apiKey' then coalesce(${comments.apiKeyName}, 'API key') else ${users.displayName} end`,
          authorAvatarUrl: sql<string | null>`case when ${comments.authorKind} in ('system', 'apiKey') then null else ${users.avatarUrl} end`,
          authorClientId: users.clientId,
          body: comments.body,
          editedAt: comments.editedAt,
          createdAt: comments.createdAt,
        })
        .from(comments)
        .innerJoin(users, eq(users.id, comments.authorId))
        .where(and(...commentConditions))
        .orderBy(desc(comments.createdAt), asc(comments.id))
        .limit(limit + 1),
      db
        .select({
          ...getTableColumns(activityEvents),
          actorName: sql<string>`case when ${activityEvents.actorKind} = 'system' then 'Kanera' when ${activityEvents.actorKind} = 'apiKey' then coalesce(${activityEvents.apiKeyName}, 'API key') else ${users.displayName} end`,
          actorAvatarUrl: sql<string | null>`case when ${activityEvents.actorKind} in ('system', 'apiKey') then null else ${users.avatarUrl} end`,
          actorClientId: users.clientId,
        })
        .from(activityEvents)
        .leftJoin(users, eq(users.id, activityEvents.actorId))
        .where(and(...activityConditions))
        .orderBy(desc(activityEvents.createdAt), asc(activityPriority), asc(activityEvents.id))
        .limit(limit + 1),
    ]);

    const [reactionsMap, mirrorIds] = await Promise.all([
      fetchReactionsByComment(commentRows.map((c) => c.id)),
      mirrorIdsByCommentId(commentRows.map((comment) => comment.id)),
    ]);

    const feed: dto.CardFeedItem[] = [
      ...commentRows.map((comment) => ({
        type: "comment" as const,
        data: signedCommentRow({ ...comment, mirrorId: mirrorIds.get(comment.id) ?? null }, reactionsMap.get(comment.id) ?? [], req.auth.cid),
      })),
      ...activityRows
        .map(({ actorClientId, actorAvatarUrl, ...event }) => ({
          type: "activity" as const,
          data: { ...event, actorAvatarUrl: actorClientId ? signedAvatarUrl(actorClientId, actorAvatarUrl) : null },
        })),
    ];

    const sortedFeed = feed.sort(compareCardFeedItems);
    const hasMore = sortedFeed.length > limit;
    const page = sortedFeed.slice(0, limit);

    return {
      items: page,
      nextCursor: hasMore
        ? encodeCursor({
            kind: "cardFeed",
            createdAt: new Date(page[page.length - 1]!.data.createdAt as unknown as string).toISOString(),
            priority: cardFeedSortPriority(page[page.length - 1]!),
            id: page[page.length - 1]!.data.id,
          })
        : null,
    } satisfies dto.CardFeedPage;
  });

  app.get("/cards/:id/comments", async (req): Promise<dto.CardCommentsPage> => {
    const { id: cardId } = req.params as { id: string };
    const query = dto.listCardCommentsQuery.parse(req.query ?? {});
    const cursor = commentCursor(query.cursor);
    const [card] = await db.select().from(cards).where(eq(cards.id, cardId)).limit(1);
    if (!card) throw notFound();
    await assertCardAccess(req.auth, card.id);

    const conditions = [eq(comments.cardId, cardId)];
    if (cursor) conditions.push(commentAfterCursor(cursor));

    const rows = await db
      .select({
        id: comments.id,
        cardId: comments.cardId,
        authorId: comments.authorId,
        authorKind: comments.authorKind,
        apiKeyId: comments.apiKeyId,
        apiKeyName: comments.apiKeyName,
        authorName: sql<string>`case when ${comments.authorKind} = 'system' then 'Kanera' when ${comments.authorKind} = 'apiKey' then coalesce(${comments.apiKeyName}, 'API key') else ${users.displayName} end`,
        authorAvatarUrl: sql<string | null>`case when ${comments.authorKind} in ('system', 'apiKey') then null else ${users.avatarUrl} end`,
        authorClientId: users.clientId,
        body: comments.body,
        editedAt: comments.editedAt,
        createdAt: comments.createdAt,
      })
      .from(comments)
      .innerJoin(users, eq(users.id, comments.authorId))
      .where(and(...conditions))
      .orderBy(desc(comments.createdAt), asc(comments.id))
      .limit(query.limit + 1);

    const hasMore = rows.length > query.limit;
    const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
    const [reactionsMap, mirrorIds] = await Promise.all([
      fetchReactionsByComment(pageRows.map((row) => row.id)),
      mirrorIdsByCommentId(pageRows.map((row) => row.id)),
    ]);

    return {
      items: pageRows.map((row) => signedCommentRow({ ...row, mirrorId: mirrorIds.get(row.id) ?? null }, reactionsMap.get(row.id) ?? [], req.auth.cid)),
      nextCursor: hasMore
        ? encodeCursor({
            kind: "cardComments",
            createdAt: pageRows[pageRows.length - 1]!.createdAt.toISOString(),
            id: pageRows[pageRows.length - 1]!.id,
          })
        : null,
    };
  });

  app.post("/cards/:id/comments", async (req, reply) => {
    const { id: cardId } = req.params as { id: string };
    const body = dto.createCommentBody.parse(req.body);

    const [card] = await db.select().from(cards).where(eq(cards.id, cardId)).limit(1);
    if (!card) throw notFound();
    const ctx = await assertCardAccess(req.auth, card.id, "editor");
    assertCardActive(card);
    // Resource access rebases an identity-wide personal credential to this card's organisation.
    // Validate and strip media only afterwards so tenant-bound media keys use the resource owner.
    assertIntegrationEmbeddedMediaStoredLocally(body.body, req.auth.cid, req.auth.authKind);
    const commentBody = stripSignedEmbeddedMediaUrls(body.body, req.auth.cid) ?? body.body;

    const { comment, mentionedUserIds } = await db.transaction(async (tx) => {
      const attribution = commentAttribution(req.auth);
      const [comment] = await tx
        .insert(comments)
        .values({ cardId, authorId: req.auth.sub, ...attribution, body: commentBody })
        .returning();

      const mentionedUserIds = await replaceCardMentions({
        tx,
        boardId: card.boardId,
        cardId,
        commentId: comment!.id,
        source: "comment",
        markdown: commentBody,
      });

      return { comment: comment!, mentionedUserIds };
    });

    if (body.attachmentIds && body.attachmentIds.length > 0) {
      await linkAttachmentsToComment({
        clientId: req.auth.cid,
        attachmentIds: body.attachmentIds,
        cardId,
        boardId: card.boardId,
        commentId: comment.id,
        userId: req.auth.sub,
      });
    }

    const selectedCommentRow = await selectCommentRow(comment.id, req.auth.cid);
    await touchCardActivity(cardId, req.auth.cid);

    const commentCreatedActivity = await recordActivity(db, {
      boardId: card.boardId,
      workspaceId: ctx.workspaceId,
      actorId: req.auth.sub,
      entityType: "comment",
      entityId: comment.id,
      action: "created",
      payload: { cardId },
    });
    await enqueueCommentAddedEmails({
      tx: db,
      mailer: app.mailer,
      webOrigin: env.WEB_ORIGIN,
      cardId,
      actorId: req.auth.sub,
      commentBody,
      excludeUserIds: mentionedUserIds,
    });
    await enqueueCommentMentionedNotifications({
      tx: db,
      mailer: app.mailer,
      webOrigin: env.WEB_ORIGIN,
      cardId,
      actorId: req.auth.sub,
      recipientUserIds: mentionedUserIds,
      commentBody,
    });
    queueNotificationFanout(commentCreatedActivity, { kind: "created" });
    emitToBoard(card.boardId, "comment:created", {
      boardId: card.boardId,
      cardId,
      comment: selectedCommentRow,
    });
    emitToBoard(card.boardId, "card:feedItem:created", {
      boardId: card.boardId,
      cardId,
      item: { type: "comment", data: selectedCommentRow },
    });
    await evaluateWorkspaceAnalyticsMilestones({
      workspaceId: ctx.workspaceId,
      actorId: req.auth.sub,
      supportSession: req.auth.authKind === "support" || req.auth.authKind === "apiKey",
    });
    return reply.status(201).send(selectedCommentRow);
  });

  app.post("/boards/:boardId/comments/bulk/create", async (req, reply) => {
    const { boardId } = req.params as { boardId: string };
    const body = dto.bulkCreateCommentsBody.parse(req.body);
    const boardAccess = await assertBoardAccess(req.auth, boardId, "editor");
    const cardIds = [...new Set(body.comments.map((entry) => entry.cardId))];
    const cardRows = await db.select().from(cards).where(inArray(cards.id, cardIds));
    const cardsById = new Map(cardRows.map((card) => [card.id, card]));

    // Validate every target before inserting anything so a stale or inaccessible card makes the
    // heterogeneous batch fail atomically instead of leaving a partially-created conversation.
    for (const cardId of cardIds) {
      const card = cardsById.get(cardId);
      if (!card || card.boardId !== boardId) throw notFound("one or more cards were not found on this board");
      assertCardActive(card);
    }
    // Board editor access is asserted once above and every card is confirmed to be on that board,
    // so only the assigned-items-only rule is still per-card — one probe for the whole batch.
    await assertBatchCardVisibility(req.auth, boardAccess, cardIds);
    const entries = body.comments.map((entry) => {
      assertIntegrationEmbeddedMediaStoredLocally(entry.body, req.auth.cid, req.auth.authKind);
      return { ...entry, body: stripSignedEmbeddedMediaUrls(entry.body, req.auth.cid) ?? entry.body };
    });

    const created = await db.transaction(async (tx) => {
      const attribution = commentAttribution(req.auth);
      const results: Array<{
        id: string;
        cardId: string;
        body: string;
        mentionedUserIds: string[];
        activity: Awaited<ReturnType<typeof recordActivity>>;
      }> = [];
      for (const entry of entries) {
        const [comment] = await tx
          .insert(comments)
          .values({ cardId: entry.cardId, authorId: req.auth.sub, ...attribution, body: entry.body })
          .returning({ id: comments.id });
        const mentionedUserIds = await replaceCardMentions({
          tx,
          boardId,
          cardId: entry.cardId,
          commentId: comment!.id,
          source: "comment",
          markdown: entry.body,
        });
        const activity = await recordActivity(tx, {
          boardId,
          workspaceId: boardAccess.workspaceId,
          actorId: req.auth.sub,
          entityType: "comment",
          entityId: comment!.id,
          action: "created",
          payload: { cardId: entry.cardId, bulk: true },
        });
        results.push({ id: comment!.id, cardId: entry.cardId, body: entry.body, mentionedUserIds, activity });
      }
      return results;
    });

    const selectedRows = await selectCommentRows(created.map((entry) => entry.id), req.auth.cid);
    for (const cardId of cardIds) await touchCardActivity(cardId, req.auth.cid);
    for (let index = 0; index < created.length; index += 1) {
      const entry = created[index]!;
      const selectedComment = selectedRows[index]!;
      await enqueueCommentAddedEmails({
        tx: db,
        mailer: app.mailer,
        webOrigin: env.WEB_ORIGIN,
        cardId: entry.cardId,
        actorId: req.auth.sub,
        commentBody: entry.body,
        excludeUserIds: entry.mentionedUserIds,
      });
      await enqueueCommentMentionedNotifications({
        tx: db,
        mailer: app.mailer,
        webOrigin: env.WEB_ORIGIN,
        cardId: entry.cardId,
        actorId: req.auth.sub,
        recipientUserIds: entry.mentionedUserIds,
        commentBody: entry.body,
      });
      void queueNotificationFanout(entry.activity, { kind: "created" });
      await emitToBoard(boardId, "comment:created", { boardId, cardId: entry.cardId, comment: selectedComment });
      await emitToBoard(boardId, "card:feedItem:created", {
        boardId,
        cardId: entry.cardId,
        item: { type: "comment", data: selectedComment },
      });
    }
    return reply.status(201).send({ created: selectedRows.length, comments: selectedRows });
  });

  app.patch("/comments/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.updateCommentBody.parse(req.body);

    const [current] = await db.select().from(comments).where(eq(comments.id, id)).limit(1);
    if (!current) throw notFound();
    if (!canMutateComment(current, req.auth)) throw forbidden();

    const [card] = await db.select().from(cards).where(eq(cards.id, current.cardId)).limit(1);
    if (!card) throw notFound();
    await assertCardAccess(req.auth, card.id, "editor");
    assertCardActive(card);
    assertIntegrationEmbeddedMediaStoredLocally(body.body, req.auth.cid, req.auth.authKind);
    const commentBody = stripSignedEmbeddedMediaUrls(body.body, req.auth.cid) ?? body.body;

    const [comment] = await db
      .update(comments)
      .set({ body: commentBody, editedAt: new Date() })
      .where(eq(comments.id, id))
      .returning();

    await replaceCardMentions({
      tx: db,
      boardId: card.boardId,
      cardId: card.id,
      commentId: comment!.id,
      source: "comment",
      markdown: commentBody,
    });

    if (body.attachmentIds && body.attachmentIds.length > 0) {
      await linkAttachmentsToComment({
        clientId: req.auth.cid,
        attachmentIds: body.attachmentIds,
        cardId: card.id,
        boardId: card.boardId,
        commentId: comment!.id,
        userId: req.auth.sub,
      });
    }

    const commentRow = await selectCommentRow(comment!.id, req.auth.cid);
    await touchCardActivity(card.id, req.auth.cid);

    emitToBoard(card.boardId, "comment:updated", {
      boardId: card.boardId,
      cardId: card.id,
      comment: commentRow,
    });
    emitToBoard(card.boardId, "card:feedItem:updated", {
      boardId: card.boardId,
      cardId: card.id,
      item: { type: "comment", data: commentRow },
    });
    return commentRow;
  });

  app.delete("/comments/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [current] = await db.select().from(comments).where(eq(comments.id, id)).limit(1);
    if (!current) throw notFound();

    const [card] = await db.select().from(cards).where(eq(cards.id, current.cardId)).limit(1);
    if (!card) throw notFound();
    const ctx = await assertCardAccess(req.auth, card.id, "editor");
    assertCardActive(card);
    // Authors retain control of their own comments, while board administrators may moderate any
    // comment on boards they manage. `isWorkspaceAdmin` is scoped to this board's organisation, so
    // a guest cannot borrow admin status from their home organisation.
    if (!canMutateComment(current, req.auth) && !ctx.isWorkspaceAdmin) throw forbidden();

    // Detach any attachments that were linked to this comment so the row's
    // commentId doesn't dangle. The attachments themselves stay on the card.
    await db
      .update(cardAttachments)
      .set({ commentId: null })
      .where(eq(cardAttachments.commentId, id));

    await db.delete(comments).where(eq(comments.id, id));
    await touchCardActivity(card.id, req.auth.cid);
    await recordActivity(db, {
      boardId: card.boardId,
      workspaceId: ctx.workspaceId,
      actorId: req.auth.sub,
      entityType: "comment",
      entityId: id,
      action: "deleted",
      payload: { cardId: card.id },
    });
    emitToBoard(card.boardId, "comment:deleted", {
      boardId: card.boardId,
      cardId: card.id,
      commentId: id,
    });
    emitToBoard(card.boardId, "card:feedItem:deleted", {
      boardId: card.boardId,
      cardId: card.id,
      type: "comment",
      itemId: id,
    });
    return reply.status(204).send();
  });

  app.post("/boards/:boardId/comments/bulk/delete", async (req) => {
    const { boardId } = req.params as { boardId: string };
    const body = dto.bulkDeleteCommentsBody.parse(req.body);
    const boardAccess = await assertBoardAccess(req.auth, boardId, "editor");
    const rows = await db
      .select({ comment: comments, card: cards })
      .from(comments)
      .innerJoin(cards, eq(cards.id, comments.cardId))
      .where(inArray(comments.id, body.commentIds));
    const byId = new Map(rows.map((row) => [row.comment.id, row]));

    // Deletion is intentionally stricter than editing board content: every comment must exist on
    // this board and be authored by the acting user. Validate the whole batch before detaching an
    // attachment or deleting a row so a mixed-ownership request cannot partially succeed. The error
    // names the offending ids so a migration agent can drop them and retry with the deletable set.
    const missingIds = body.commentIds.filter((id) => {
      const row = byId.get(id);
      return !row || row.card.boardId !== boardId;
    });
    if (missingIds.length > 0) throw notFound(`comments not found on this board: ${missingIds.join(", ")}`);
    // Only comments the acting user authored are deletable. Comments from other users, API keys, or
    // the system are rejected — an API key or OAuth connection cannot delete comments it did not
    // author, even with board-editor access.
    const notOwnedIds = body.commentIds.filter((id) => {
      const { comment } = byId.get(id)!;
      return comment.authorKind !== "user" || comment.authorId !== req.auth.sub;
    });
    if (notOwnedIds.length > 0) throw forbidden(`bulk delete only removes comments you authored; not authored by you: ${notOwnedIds.join(", ")}`);
    for (const commentId of body.commentIds) assertCardActive(byId.get(commentId)!.card);
    // Same batch reasoning as bulk create: board editor access is already established for this
    // board and every comment was matched to a card on it.
    await assertBatchCardVisibility(req.auth, boardAccess, rows.map((row) => row.card.id));

    const deletedIds = await db.transaction(async (tx) => {
      await tx
        .update(cardAttachments)
        .set({ commentId: null })
        .where(inArray(cardAttachments.commentId, body.commentIds));
      const deleted = await tx
        .delete(comments)
        .where(inArray(comments.id, body.commentIds))
        .returning({ id: comments.id });
      if (deleted.length !== body.commentIds.length) {
        throw badRequest("a comment changed while applying the batch; retry with a fresh comment list");
      }
      for (const commentId of body.commentIds) {
        const row = byId.get(commentId)!;
        await recordActivity(tx, {
          boardId,
          workspaceId: boardAccess.workspaceId,
          actorId: req.auth.sub,
          entityType: "comment",
          entityId: commentId,
          action: "deleted",
          payload: { cardId: row.card.id, bulk: true },
        });
      }
      return deleted.map((row) => row.id);
    });

    for (const cardId of new Set(rows.map((row) => row.card.id))) {
      await touchCardActivity(cardId, req.auth.cid);
    }

    for (const commentId of body.commentIds) {
      const row = byId.get(commentId)!;
      await emitToBoard(boardId, "comment:deleted", { boardId, cardId: row.card.id, commentId });
      await emitToBoard(boardId, "card:feedItem:deleted", {
        boardId,
        cardId: row.card.id,
        type: "comment",
        itemId: commentId,
      });
    }
    return { deleted: deletedIds.length, commentIds: deletedIds };
  });

  app.post("/comments/:id/reactions", async (req, reply) => {
    const { id: commentId } = req.params as { id: string };
    const body = dto.addReactionBody.parse(req.body);

    const [current] = await db.select().from(comments).where(eq(comments.id, commentId)).limit(1);
    if (!current) throw notFound();
    if (current.authorKind === "user" && current.authorId === req.auth.sub) throw badRequest("cannot react to your own comment");

    const [card] = await db.select().from(cards).where(eq(cards.id, current.cardId)).limit(1);
    if (!card) throw notFound();
    await assertCardAccess(req.auth, card.id, "editor");
    assertCardActive(card);

    const inserted = await db
      .insert(commentReactions)
      .values({ commentId, userId: req.auth.sub, reactionType: body.type })
      .onConflictDoNothing({
        target: [commentReactions.commentId, commentReactions.userId, commentReactions.reactionType],
      })
      .returning({ id: commentReactions.id });

    if (inserted.length > 0) {
      const [user] = await db
        .select({ id: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl, homeClientId: users.clientId })
        .from(users)
        .where(eq(users.id, req.auth.sub))
        .limit(1);
      if (user) {
        emitToBoard(card.boardId, "comment:reaction:added", {
          boardId: card.boardId,
          cardId: card.id,
          commentId,
          type: body.type,
          user: {
            id: user.id,
            displayName: user.displayName,
            avatarUrl: withSignedMedia(user.homeClientId, { avatarUrl: user.avatarUrl }).avatarUrl,
          },
        });
      }
    }
    return reply.status(204).send();
  });

  app.delete("/comments/:id/reactions/:type", async (req, reply) => {
    const { id: commentId, type: typeParam } = req.params as { id: string; type: string };
    const type = dto.reactionTypeSchema.parse(typeParam);

    const [current] = await db.select().from(comments).where(eq(comments.id, commentId)).limit(1);
    if (!current) throw notFound();

    const [card] = await db.select().from(cards).where(eq(cards.id, current.cardId)).limit(1);
    if (!card) throw notFound();
    await assertCardAccess(req.auth, card.id, "editor");
    assertCardActive(card);

    const removed = await db
      .delete(commentReactions)
      .where(
        and(
          eq(commentReactions.commentId, commentId),
          eq(commentReactions.userId, req.auth.sub),
          eq(commentReactions.reactionType, type),
        ),
      )
      .returning({ id: commentReactions.id });

    if (removed.length > 0) {
      emitToBoard(card.boardId, "comment:reaction:removed", {
        boardId: card.boardId,
        cardId: card.id,
        commentId,
        type,
        userId: req.auth.sub,
      });
    }
    return reply.status(204).send();
  });
}
