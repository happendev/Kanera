import { conditionalCardResponse } from "../../lib/conditional-card-response.js";
import { dto } from "@kanera/shared";
import { cards, comments } from "@kanera/shared/schema";
import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { assertBatchCardVisibility, assertBoardAccess, assertCardAccess } from "../../lib/access.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { stripSignedEmbeddedMediaUrls } from "../../lib/media-keys.js";
import { assertCardActive, assertIntegrationEmbeddedMediaStoredLocally } from "../../lib/card-guards.js";
import { loadCardFeedPage } from "./card-feed.js";
import { addCommentReaction, emitCommentReactionAdded, emitCommentReactionRemoved, removeCommentReaction } from "./comment-reactions.js";
import { cardFeedCursor, commentCursor, listCardComments } from "./comment-queries.js";
import { bulkCreateComments, createComment, emitBulkCommentsCreated, emitCommentCreated } from "./create-comment.js";
import { bulkDeleteComments, deleteComment, emitBulkCommentsDeleted, emitCommentDeleted } from "./delete-comment.js";
import { canMutateComment } from "./route-support.js";
import { emitCommentUpdated, updateComment } from "./update-comment.js";

export async function commentRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/cards/:id/feed", async (req, reply) => {
    const { id: cardId } = req.params as { id: string };
    const query = dto.listCardFeedQuery.parse(req.query ?? {});
    const limit = query.limit;
    const cursor = cardFeedCursor(query.cursor);
    const [card] = await db.select().from(cards).where(eq(cards.id, cardId)).limit(1);
    if (!card) throw notFound();
    // The row is already in hand; passing it skips a redundant re-read of its board_id.
    await assertCardAccess(req.auth, card);

    const result = await loadCardFeedPage({ card, cursor, limit, clientId: req.auth.cid });
    return conditionalCardResponse(req, reply, result);
  });

  app.get("/cards/:id/comments", async (req): Promise<dto.CardCommentsPage> => {
    const { id: cardId } = req.params as { id: string };
    const query = dto.listCardCommentsQuery.parse(req.query ?? {});
    const cursor = commentCursor(query.cursor);
    const [card] = await db.select().from(cards).where(eq(cards.id, cardId)).limit(1);
    if (!card) throw notFound();
    await assertCardAccess(req.auth, card);

    return listCardComments({ cardId, cursor, limit: query.limit, clientId: req.auth.cid });
  });

  app.post("/cards/:id/comments", async (req, reply) => {
    const { id: cardId } = req.params as { id: string };
    const body = dto.createCommentBody.parse(req.body);

    const [card] = await db.select().from(cards).where(eq(cards.id, cardId)).limit(1);
    if (!card) throw notFound();
    const ctx = await assertCardAccess(req.auth, card, "editor");
    assertCardActive(card);
    // Resource access rebases an identity-wide personal credential to this card's organisation.
    // Validate and strip media only afterwards so tenant-bound media keys use the resource owner.
    assertIntegrationEmbeddedMediaStoredLocally(body.body, req.auth.cid, req.auth.authKind);
    const commentBody = stripSignedEmbeddedMediaUrls(body.body, req.auth.cid) ?? body.body;

    const result = await createComment({ auth: req.auth, card, ctx, body, commentBody });
    await emitCommentCreated({ auth: req.auth, mailer: app.mailer, result });
    return reply.status(201).send(result.selectedCommentRow);
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

    const result = await bulkCreateComments({ auth: req.auth, boardId, boardAccess, cardIds, entries });
    await emitBulkCommentsCreated({ auth: req.auth, mailer: app.mailer, result });
    return reply.status(201).send({ created: result.selectedRows.length, comments: result.selectedRows });
  });

  app.patch("/comments/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = dto.updateCommentBody.parse(req.body);

    const [current] = await db.select().from(comments).where(eq(comments.id, id)).limit(1);
    if (!current) throw notFound();
    if (!canMutateComment(current, req.auth)) throw forbidden();

    const [card] = await db.select().from(cards).where(eq(cards.id, current.cardId)).limit(1);
    if (!card) throw notFound();
    await assertCardAccess(req.auth, card, "editor");
    assertCardActive(card);
    assertIntegrationEmbeddedMediaStoredLocally(body.body, req.auth.cid, req.auth.authKind);
    const commentBody = stripSignedEmbeddedMediaUrls(body.body, req.auth.cid) ?? body.body;

    const result = await updateComment({ auth: req.auth, commentId: id, card, body, commentBody });
    await emitCommentUpdated(result);
    return result.commentRow;
  });

  app.delete("/comments/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [current] = await db.select().from(comments).where(eq(comments.id, id)).limit(1);
    if (!current) throw notFound();

    const [card] = await db.select().from(cards).where(eq(cards.id, current.cardId)).limit(1);
    if (!card) throw notFound();
    const ctx = await assertCardAccess(req.auth, card, "editor");
    assertCardActive(card);
    // Authors retain control of their own comments, while board administrators may moderate any
    // comment on boards they manage. `isWorkspaceAdmin` is scoped to this board's organisation, so
    // a guest cannot borrow admin status from their home organisation.
    if (!canMutateComment(current, req.auth) && !ctx.isWorkspaceAdmin) throw forbidden();

    const result = await deleteComment({ auth: req.auth, commentId: id, card, ctx });
    await emitCommentDeleted(result);
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

    const result = await bulkDeleteComments({ auth: req.auth, boardId, boardAccess, commentIds: body.commentIds, rows, byId });
    await emitBulkCommentsDeleted(result);
    return { deleted: result.deletedIds.length, commentIds: result.deletedIds };
  });

  app.post("/comments/:id/reactions", async (req, reply) => {
    const { id: commentId } = req.params as { id: string };
    const body = dto.addReactionBody.parse(req.body);

    const [current] = await db.select().from(comments).where(eq(comments.id, commentId)).limit(1);
    if (!current) throw notFound();
    if (current.authorKind === "user" && current.authorId === req.auth.sub) throw badRequest("cannot react to your own comment");

    const [card] = await db.select().from(cards).where(eq(cards.id, current.cardId)).limit(1);
    if (!card) throw notFound();
    await assertCardAccess(req.auth, card, "editor");
    assertCardActive(card);

    const result = await addCommentReaction({ auth: req.auth, comment: current, card, body });
    await emitCommentReactionAdded({ auth: req.auth, mailer: app.mailer, log: req.log, result });
    return reply.status(204).send();
  });

  app.delete("/comments/:id/reactions/:type", async (req, reply) => {
    const { id: commentId, type: typeParam } = req.params as { id: string; type: string };
    const type = dto.reactionTypeSchema.parse(typeParam);

    const [current] = await db.select().from(comments).where(eq(comments.id, commentId)).limit(1);
    if (!current) throw notFound();

    const [card] = await db.select().from(cards).where(eq(cards.id, current.cardId)).limit(1);
    if (!card) throw notFound();
    await assertCardAccess(req.auth, card, "editor");
    assertCardActive(card);

    const result = await removeCommentReaction({ auth: req.auth, comment: current, card, type });
    await emitCommentReactionRemoved({ auth: req.auth, log: req.log, result });
    return reply.status(204).send();
  });
}
