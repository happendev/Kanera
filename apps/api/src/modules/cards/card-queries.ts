import type { SelectedCardContentQueryBody } from "@kanera/shared/dto";
import type { WireCardDetail } from "@kanera/shared/events";
import { cardAssignees, cardAttachments, cardChecklistTemplateApplications, cardCustomFieldValues, cardLabelAssignments, cards, users, type Card } from "@kanera/shared/schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { assignedCardVisibility, type assertBoardAccess, type assertCardAccess } from "../../lib/access.js";
import { loadChecklistsForCard, loadChecklistsForCards } from "../../lib/checklist-rows.js";
import { shapeAttachmentMedia } from "../../lib/attachment-media.js";
import { signedAvatarUrl, signEmbeddedMediaUrls } from "../../lib/media-keys.js";
import { loadLinkedNotesForCard } from "../../lib/internal-links.js";
import { toWireCard } from "../../lib/wire-card.js";
import { attachmentRowBaseColumns } from "../../lib/attachment-rows.js";
import { fetchReactionsByAttachment } from "../../lib/comment-reactions.js";
import { loadCardRelations } from "../../lib/card-relations.js";
import { loadWorkspaceFeatures } from "../../lib/workspace-features.js";
import { orderedUniqueIds } from "./route-support.js";

// Upper bound on comments serialized per card by the bounded content-query endpoint. Chosen to
// comfortably cover normal card discussions while keeping a 200-card response bounded; cards that
// exceed it are flagged so callers page the full history via GET /cards/{id}/comments instead.
const CONTENT_QUERY_COMMENT_CAP = 250;

// Keep the aggregate query and serialized comment bodies bounded even when all 200 selected cards
// have unusually large histories. Per-card totals from the ranked query still let callers identify
// every truncated card and page it through the dedicated comments endpoint.
const CONTENT_QUERY_GLOBAL_COMMENT_CAP = 500;

const CONTENT_QUERY_COMMENT_BODY_BUDGET_BYTES = 4 * 1024 * 1024;

type ContentQueryCommentRow = {
  id: string;
  cardId: string;
  authorId: string;
  authorKind: "user" | "apiKey" | "system";
  apiKeyId: string | null;
  apiKeyName: string | null;
  authorName: string;
  body: string;
  editedAt: Date | null;
  createdAt: Date;
  totalCount: number;
};

/**
 * The card drawer's detail payload for a card the caller may already read. The caller passes the
 * access context from `assertCardAccess` so the linked-note and feature reads stay workspace-scoped.
 */
export async function loadCardDetail({
  auth,
  card,
  ctx,
}: {
  auth: AuthClaims;
  card: Card;
  ctx: Awaited<ReturnType<typeof assertCardAccess>>;
}): Promise<WireCardDetail> {
  const id = card.id;
  const attachmentsQuery = db
    .select(attachmentRowBaseColumns)
    .from(cardAttachments)
    .innerJoin(users, eq(users.id, cardAttachments.uploadedById))
    .where(eq(cardAttachments.cardId, id))
    .orderBy(desc(cardAttachments.createdAt));
  const [customFieldValues, labelAssignments, assignees, [attachments, attachmentReactions], checklists, appliedTemplateRows, linkedNotes, relations, features] = await Promise.all([
    db.select().from(cardCustomFieldValues).where(eq(cardCustomFieldValues.cardId, id)),
    db
      .select({ labelId: cardLabelAssignments.labelId })
      .from(cardLabelAssignments)
      .where(eq(cardLabelAssignments.cardId, id)),
    db
      .select({ userId: cardAssignees.userId })
      .from(cardAssignees)
      .where(eq(cardAssignees.cardId, id)),
    // Reactions need only the attachment ids, so they chain off that query instead of waiting for
    // the slowest of the other reads.
    attachmentsQuery.then(async (rows) => [rows, await fetchReactionsByAttachment(rows.map((attachment) => attachment.id))] as const),
    loadChecklistsForCard(id),
    db
      .select({ templateId: cardChecklistTemplateApplications.templateId })
      .from(cardChecklistTemplateApplications)
      .where(eq(cardChecklistTemplateApplications.cardId, id)),
    loadLinkedNotesForCard(auth, id, ctx.workspaceId),
    loadCardRelations(auth, id),
    loadWorkspaceFeatures(ctx.workspaceId),
  ]);

  return {
    revision: String(card.detailRevision),
    // A start date is kept, unreported, while the workspace has the timeline switched off.
    card: toWireCard(features.timeline ? card : { ...card, startDateLocalDate: null }, auth.cid),
    customFieldValues,
    labelIds: labelAssignments.map((assignment) => assignment.labelId),
    assigneeIds: assignees.map((assignee) => assignee.userId),
    attachments: attachments.map(({ uploadedByClientId, uploadedByAvatarUrl, ...attachment }) => ({
      ...shapeAttachmentMedia(attachment),
      uploadedByAvatarUrl: signedAvatarUrl(uploadedByClientId, uploadedByAvatarUrl),
      reactions: attachmentReactions.get(attachment.id) ?? [],
    })),
    checklists,
    appliedChecklistTemplateIds: appliedTemplateRows.map((row) => row.templateId),
    linkedNotes,
    relations: relations.relations,
    hiddenBlockerCount: relations.hiddenBlockerCount,
  };
}

/**
 * Bounded bulk read of selected cards' content (card, checklists, comments) on one board, for
 * audit and migration integrations. The caller has already asserted board access.
 */
export async function queryCardContent({
  auth,
  boardId,
  ctx,
  body,
}: {
  auth: AuthClaims;
  boardId: string;
  ctx: Awaited<ReturnType<typeof assertBoardAccess>>;
  body: SelectedCardContentQueryBody;
}) {
  const requestedIds = orderedUniqueIds(body.cardIds);

  // Best-effort read: unlike the bulk mutations, a bounded audit/migration fetch should not fail
  // the whole batch because a single id was moved off the board or deleted since the caller last
  // read it. Ids that are not on this board (or not visible under assignedItemsOnly) are reported
  // in missingCardIds so an integration correlating by index can reconcile without a retry.
  const cardRows = await db
    .select()
    .from(cards)
    .where(and(
      eq(cards.boardId, boardId),
      inArray(cards.id, requestedIds),
      ctx.assignedItemsOnly ? assignedCardVisibility(auth.sub) : undefined,
    ));
  const cardById = new Map(cardRows.map((card) => [card.id, card]));
  const selectedCards = requestedIds
    .map((id) => cardById.get(id))
    .filter((card): card is typeof cards.$inferSelect => Boolean(card));
  const missingCardIds = requestedIds.filter((id) => !cardById.has(id));
  const cardIds = selectedCards.map((card) => card.id);

  const [checklistsByCard, commentResult] = await Promise.all([
    loadChecklistsForCards(cardIds),
    cardIds.length === 0
      ? Promise.resolve({ rows: [] as ContentQueryCommentRow[] })
      : db.execute<ContentQueryCommentRow>(sql`
        with ranked_comments as (
          select
            c.id,
            c.card_id as "cardId",
            c.author_id as "authorId",
            c.author_kind as "authorKind",
            c.api_key_id as "apiKeyId",
            c.api_key_name as "apiKeyName",
            case
              when c.author_kind = 'system' then 'Kanera'
              when c.author_kind = 'apiKey' then coalesce(c.api_key_name, 'API key')
              else u.display_name
            end as "authorName",
            c.body,
            c.edited_at as "editedAt",
            c.created_at as "createdAt",
            count(*) over (partition by c.card_id)::integer as "totalCount",
            row_number() over (partition by c.card_id order by c.created_at, c.id) as comment_rank
          from comment c
          inner join "user" u on u.id = c.author_id
          where c.card_id in (${sql.join(cardIds.map((cardId) => sql`${cardId}`), sql`, `)})
        )
        select
          id, "cardId", "authorId", "authorKind", "apiKeyId", "apiKeyName", "authorName",
          body, "editedAt", "createdAt", "totalCount"
        from ranked_comments
        where comment_rank <= ${CONTENT_QUERY_COMMENT_CAP}
        order by comment_rank, "cardId", "createdAt", id
        limit ${CONTENT_QUERY_GLOBAL_COMMENT_CAP}
      `),
  ]);
  // Raw SQL bypasses Drizzle's timestamp mapper, so normalize timestamptz values before Fastify
  // serializes them and preserve the ISO timestamp contract used by the other comment endpoints.
  const commentRows = commentResult.rows.map((comment) => ({
    ...comment,
    editedAt: comment.editedAt ? new Date(String(comment.editedAt)) : null,
    createdAt: new Date(String(comment.createdAt)),
  }));
  // The SQL query enforces both per-card and aggregate row limits. The byte budget handles the
  // independent worst case where a bounded number of comments all contain maximum-size bodies.
  const commentsByCard = new Map<string, Omit<ContentQueryCommentRow, "totalCount">[]>();
  const totalCountByCard = new Map<string, number>();
  const retainedCountByCard = new Map<string, number>();
  let retainedBodyBytes = 0;
  for (const comment of commentRows) totalCountByCard.set(comment.cardId, comment.totalCount);
  for (const { totalCount: _totalCount, ...comment } of commentRows) {
    const signedBody = signEmbeddedMediaUrls(comment.body, auth.cid) ?? comment.body;
    const bodyBytes = Buffer.byteLength(signedBody, "utf8");
    if (retainedBodyBytes + bodyBytes > CONTENT_QUERY_COMMENT_BODY_BUDGET_BYTES) continue;
    retainedBodyBytes += bodyBytes;
    const cardComments = commentsByCard.get(comment.cardId) ?? [];
    cardComments.push({ ...comment, body: signedBody });
    commentsByCard.set(comment.cardId, cardComments);
    retainedCountByCard.set(comment.cardId, (retainedCountByCard.get(comment.cardId) ?? 0) + 1);
  }
  const truncatedCardIds = new Set<string>();
  for (const [cardId, totalCount] of totalCountByCard) {
    if ((retainedCountByCard.get(cardId) ?? 0) < totalCount) truncatedCardIds.add(cardId);
  }

  // Preserve caller card order so an integration can correlate the response without rebuilding
  // an index, while comments and checklist content remain deterministically chronological.
  return {
    cards: selectedCards.map((card) => ({
      card: toWireCard(card, auth.cid),
      checklists: checklistsByCard.get(card.id) ?? [],
      comments: commentsByCard.get(card.id) ?? [],
    })),
    missingCardIds,
    truncatedCardIds: Array.from(truncatedCardIds),
  };
}
