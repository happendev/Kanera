import { cardAttachments, comments, users } from "@kanera/shared/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../db.js";
import { lockCardsForWrite } from "../../lib/card-write-lock.js";
import { notFound } from "../../lib/errors.js";
import { signedAvatarUrl, unsignedMediaUrl, withSignedMedia } from "../../lib/media-keys.js";
import { emitToBoard } from "../../realtime/emit.js";
import { attachmentRowBaseColumns } from "../../lib/attachment-rows.js";

export async function linkAttachmentsToComment(params: {
  clientId: string;
  attachmentIds: string[];
  cardId: string;
  boardId: string;
  commentId: string;
  userId: string;
}) {
  const { clientId, attachmentIds, cardId, boardId, commentId, userId } = params;
  if (attachmentIds.length === 0) return;
  const updated = await db.transaction(async (tx) => {
    await lockCardsForWrite(tx, [cardId]);
    const [comment] = await tx.select({ id: comments.id }).from(comments).where(eq(comments.id, commentId));
    if (!comment) throw notFound();
    return tx
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
  });
  if (updated.length === 0) return;
  const rows = await db
    .select(attachmentRowBaseColumns)
    .from(cardAttachments)
    .innerJoin(users, eq(users.id, cardAttachments.uploadedById))
    .where(inArray(cardAttachments.id, updated.map((u) => u.id)));
  for (const { uploadedByClientId, uploadedByAvatarUrl, ...row } of rows) {
    // Re-emit as created so clients upsert the row with the new commentId/source.
    await emitToBoard(boardId, "card:attachment:created", {
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

export function commentAttribution(auth: { authKind?: string; apiKeyKind?: string; apiKeyId?: string; apiKeyName?: string; agentGrantId?: string; agentName?: string }) {
  // An AI agent acting through an interactive OAuth grant: the comment belongs to the person
  // (authorId) but is labelled as agent-written. The synthetic OAuth apiKeyId is a rate-limit key
  // only and must never reach the UUID FK on comment rows.
  if (auth.apiKeyKind === "personal" && auth.agentGrantId) {
    return { authorKind: "agent" as const, apiKeyId: null, apiKeyName: null, agentGrantId: auth.agentGrantId, agentName: auth.agentName ?? "AI agent" };
  }
  // Other personal credentials act as their owning user.
  if (auth.authKind !== "apiKey" || auth.apiKeyKind === "personal") {
    return { authorKind: "user" as const, apiKeyId: null, apiKeyName: null, agentGrantId: null, agentName: null };
  }
  return {
    authorKind: "apiKey" as const,
    apiKeyId: auth.apiKeyId ?? null,
    apiKeyName: auth.apiKeyName ?? "API key",
    agentGrantId: null,
    agentName: null,
  };
}

export function canMutateComment(
  comment: { authorId: string; authorKind: string; apiKeyId: string | null },
  auth: { sub: string; authKind?: string; apiKeyId?: string },
) {
  // The person an agent acts for owns the agent's comments, and the agent (same sub) can edit them.
  if (comment.authorKind === "user" || comment.authorKind === "agent") return comment.authorId === auth.sub;
  return comment.authorKind === "apiKey"
    && auth.authKind === "apiKey"
    && comment.apiKeyId !== null
    && comment.apiKeyId === auth.apiKeyId;
}

/** Minimal logger shape so use-case files take `req.log` as a plain value without Fastify types. */
export type WarnLogger = { warn: (obj: object, msg: string) => void };
