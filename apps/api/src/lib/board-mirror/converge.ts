import { SERVER_EVENTS, type CardAttachmentRow, type WireCard } from "@kanera/shared/events";
import {
  ACTIVITY_ACTION,
  activityEvents,
  boardMirrorLists,
  boards,
  cardAttachments,
  cardChecklistItems,
  cardChecklists,
  cardCustomFieldValues,
  cardLabelAssignments,
  cardLabels,
  cards,
  comments,
  customFieldOptions,
  customFields,
  externalLinks,
  lists,
  users,
  workspaceMembers,
  workspaces,
  type BoardMirror,
  type BoardMirrorFacet,
  type ActivityEvent,
} from "@kanera/shared/schema";
import { and, asc, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { emitActivityFeedItem, emitActivityFeedItemDeleted, emitActivityFeedItemUpdated, recordActivity } from "../activity.js";
import { shapeAttachmentMedia } from "../attachment-media.js";
import { emitLaneRebalanced, positionForLaneInsert, rebalanceBoardLane } from "../board-lane.js";
import { assertCanUploadAttachment } from "../entitlements.js";
import { deleteExternalLinks, findExternalLink, findExternalLinks, listExternalLinksByProvider, upsertExternalLink } from "../external-links.js";
import { signEmbeddedMediaUrls } from "../media-keys.js";
import { withSignedMedia } from "../media-keys.js";
import { replaceCardMentions } from "../mentions.js";
import { clearNotificationsForCards, emitDeletedNotifications, type DeletedNotificationRef } from "../notifications.js";
import { emitToBoard } from "../../realtime/emit.js";
import { getStorageForClient } from "../storage/index.js";
import {
  duplicateCardInto,
  copyAttachmentBlobs,
  duplicateCustomFieldValues,
  duplicateLabelIds,
  emitDuplicatedCardIntoBoard,
  loadChecklistsForCard,
} from "../../modules/cards/duplicate-card.js";
import { mirrorActor } from "./actor.js";
import { emitMirrorMetadataToBoards } from "./events.js";

// Facets always run in this order, regardless of the array-union order on a dirty row. In
// particular comments must exist before attachment associations, and every entity mapping must
// exist before activity payloads are rewritten to target ids.
const CANONICAL_FACETS: BoardMirrorFacet[] = ["link", "core", "labels", "fields", "comments", "attachments", "checklists", "activities"];
const ALL_SYNC_FACETS: BoardMirrorFacet[] = CANONICAL_FACETS.filter((facet) => facet !== "link");
const SOURCE_ARCHIVE_COMMENT_LINK_TYPE = "cardSourceArchiveComment";
const SOURCE_ARCHIVED_COMMENT = "The original card was archived.";
// Marks that the destination card's *current* archived state was set by this mirror, not by a
// destination user. Its presence is what lets a later source unarchive flow back through; its
// absence keeps a user-archived copy terminal. Pointing entityId at the target card means
// detachDeletedSource's existing prune-by-entityId sweep removes it when the source is deleted.
const TARGET_MIRROR_ARCHIVE_LINK_TYPE = "cardTargetMirrorArchive";

function providerFor(mirror: BoardMirror): string {
  return `mirror:${mirror.id}`;
}

function groupBy<T>(values: T[], keyFor: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) groups.set(keyFor(value), [...(groups.get(keyFor(value)) ?? []), value]);
  return groups;
}

function toWireCard(card: typeof cards.$inferSelect, clientId: string): WireCard {
  const { clientToken: _clientToken, ...publicCard } = card;
  return {
    ...publicCard,
    description: signEmbeddedMediaUrls(card.description, clientId),
    url: new URL(`/b/${card.boardId}/c/${card.id}`, env.WEB_ORIGIN).toString(),
  };
}

async function targetCardFor(mirror: BoardMirror, sourceCardId: string) {
  const link = await findExternalLink({
    workspaceId: mirror.targetWorkspaceId,
    provider: providerFor(mirror),
    externalType: "card",
    externalId: sourceCardId,
  });
  if (!link || link.entityType !== "card") return null;
  const [targetCard] = await db.select().from(cards).where(eq(cards.id, link.entityId)).limit(1);
  // Keep the card link when an archived destination is eventually purged. Its continued presence
  // is the durable record that this source card was already synced and must never be recreated.
  return targetCard ?? null;
}

async function sourceListMapping(mirrorId: string, sourceListId: string) {
  const [mapping] = await db
    .select({ targetListId: boardMirrorLists.targetListId, archivedAt: lists.archivedAt })
    .from(boardMirrorLists)
    .innerJoin(lists, eq(lists.id, boardMirrorLists.targetListId))
    .where(and(eq(boardMirrorLists.mirrorId, mirrorId), eq(boardMirrorLists.sourceListId, sourceListId)))
    .limit(1);
  return mapping ?? null;
}

async function targetListIsMapped(mirrorId: string, targetListId: string) {
  const [mapping] = await db
    .select({ mirrorId: boardMirrorLists.mirrorId })
    .from(boardMirrorLists)
    .where(and(eq(boardMirrorLists.mirrorId, mirrorId), eq(boardMirrorLists.targetListId, targetListId)))
    .limit(1);
  return Boolean(mapping);
}

export async function linkSourceCard(mirror: BoardMirror, sourceCardId: string): Promise<boolean> {
  const existingLink = await findExternalLink({
    workspaceId: mirror.targetWorkspaceId,
    provider: providerFor(mirror),
    externalType: "card",
    externalId: sourceCardId,
  });
  // A missing entity behind an existing link means the destination user removed the synced card.
  // The link deliberately survives as a tombstone so later source changes cannot recreate it.
  if (existingLink) return false;
  const [sourceRow] = await db
    .select({ source: cards, sourceBoardName: boards.name })
    .from(cards)
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .where(and(eq(cards.id, sourceCardId), eq(cards.boardId, mirror.sourceBoardId)))
    .limit(1);
  if (!sourceRow) return false;
  const { source, sourceBoardName } = sourceRow;
  const mapping = await sourceListMapping(mirror.id, source.listId);
  if (!mapping || mapping.archivedAt) return false;

  const actor = await mirrorActor(mirror);
  const allAttachmentRows = await db.select({ bytes: cardAttachments.byteSize }).from(cardAttachments).where(eq(cardAttachments.cardId, source.id));
  const attachmentBytes = allAttachmentRows.reduce((sum, row) => sum + row.bytes, 0);
  if (attachmentBytes > 0) {
    await assertCanUploadAttachment(db, actor.cid, attachmentBytes);
  }

  const [sourceWorkspace] = await db.select({ clientId: workspaces.clientId }).from(workspaces).where(eq(workspaces.id, mirror.sourceWorkspaceId)).limit(1);
  if (!sourceWorkspace) throw new Error("board mirror source workspace no longer exists");

  const positionResult = await positionForLaneInsert({ boardId: mirror.targetBoardId, listId: mapping.targetListId, beforeItem: null });
  const sourceCardHref = `/b/${source.boardId}/c/${source.id}`;
  const sourceCardUrl = new URL(sourceCardHref, env.WEB_ORIGIN).toString();
  const sourceLinkCommentId = randomUUID();
  const duplicated = await duplicateCardInto({
    source,
    srcCtx: { workspaceId: mirror.sourceWorkspaceId, clientId: sourceWorkspace.clientId },
    dstCtx: {
      boardId: mirror.targetBoardId,
      workspaceId: mirror.targetWorkspaceId,
      clientId: actor.cid,
      role: "editor",
      source: "workspace",
      canAccessWorkspace: true,
      isWorkspaceAdmin: true,
      assignedItemsOnly: false,
    },
    targetBoardId: mirror.targetBoardId,
    targetListId: mapping.targetListId,
    position: positionResult.position,
    actor,
    // Initial mirror creation preserves only assignees who are already assignable on the target.
    // Later assignment changes are intentionally not a mirror facet, so target ownership can
    // diverge after this first snapshot without the source continually overwriting it.
    includeAssignees: true,
    // Historical feed state is reconciled after every entity identity has committed. This avoids
    // inserting source ids when the source emitted activity before its content event.
    includeActivityHistory: false,
    autoWatch: false,
    systemAttributeComments: true,
    activityActorKind: "system",
    includeLifecycleState: true,
    includeArchivedState: false,
    includeCover: true,
    resetChecklistItemCompletion: true,
    resolveChecklistAssigneesIndependently: true,
    resolveMirrorAssigneesFromBoardAccess: true,
    resolveCustomFieldUsersFromWorkspace: true,
    attributeCreatedActivityToSource: true,
    createdActivityPayload: { mirrorId: mirror.id },
    withinTx: async (tx, { newCard, ids }) => {
      await upsertExternalLink({ workspaceId: mirror.targetWorkspaceId, provider: providerFor(mirror), externalType: "card", externalId: source.id, entityType: "card", entityId: newCard.id }, tx);
      for (const [externalId, entityId] of ids.comments) await upsertExternalLink({ workspaceId: mirror.targetWorkspaceId, provider: providerFor(mirror), externalType: "comment", externalId, entityType: "comment", entityId }, tx);
      for (const [externalId, entityId] of ids.attachments) await upsertExternalLink({ workspaceId: mirror.targetWorkspaceId, provider: providerFor(mirror), externalType: "cardAttachment", externalId, entityType: "cardAttachment", entityId }, tx);
      for (const [externalId, entityId] of ids.checklists) await upsertExternalLink({ workspaceId: mirror.targetWorkspaceId, provider: providerFor(mirror), externalType: "cardChecklist", externalId, entityType: "cardChecklist", entityId }, tx);
      for (const [externalId, entityId] of ids.checklistItems) await upsertExternalLink({ workspaceId: mirror.targetWorkspaceId, provider: providerFor(mirror), externalType: "cardChecklistItem", externalId, entityType: "cardChecklistItem", entityId }, tx);
      for (const [externalId, entityId] of ids.activities) await upsertExternalLink({ workspaceId: mirror.targetWorkspaceId, provider: providerFor(mirror), externalType: "activity", externalId, entityType: "activity", entityId }, tx);
      await tx.insert(comments).values({
        id: sourceLinkCommentId,
        cardId: newCard.id,
        authorId: mirror.createdById,
        authorKind: "system",
        apiKeyName: "Board mirror",
        body: `This card was synced from board ${sourceBoardName}. Original card URL: [View original card](${sourceCardHref})`,
      });
      // This provenance note belongs to the destination card rather than the managed source-comment
      // set, so later source comment convergence must leave it in place.
      await recordActivity(tx, {
        boardId: mirror.targetBoardId,
        workspaceId: mirror.targetWorkspaceId,
        actorId: mirror.createdById,
        actorKind: "system",
        entityType: "comment",
        entityId: sourceLinkCommentId,
        action: ACTIVITY_ACTION.CREATED,
        payload: { cardId: newCard.id, mirrorId: mirror.id, sourceCardUrl },
      });
    },
  });

  if (positionResult.needsRebalance) {
    const positions = await rebalanceBoardLane(mapping.targetListId, mirror.targetBoardId);
    await emitLaneRebalanced(mirror.targetBoardId, mapping.targetListId, positions);
  }
  await emitDuplicatedCardIntoBoard({
    actor,
    boardId: mirror.targetBoardId,
    card: duplicated.newCard,
    activity: duplicated.activity,
    labelIds: duplicated.labelIds,
    assigneeIds: duplicated.assigneeIds,
    customFieldValues: duplicated.customFieldValues,
    attachmentRows: duplicated.attachmentRows,
  });
  const [sourceLinkComment] = await db.select().from(comments).where(eq(comments.id, sourceLinkCommentId)).limit(1);
  if (sourceLinkComment) {
    const wireComment = {
      ...sourceLinkComment,
      authorName: "Kanera",
      authorAvatarUrl: null,
      reactions: [],
      mirrorId: mirror.id,
    };
    await emitToBoard(mirror.targetBoardId, SERVER_EVENTS.COMMENT_CREATED, {
      boardId: mirror.targetBoardId,
      cardId: duplicated.newCard.id,
      comment: wireComment,
    });
    await emitToBoard(mirror.targetBoardId, SERVER_EVENTS.CARD_FEED_ITEM_CREATED, {
      boardId: mirror.targetBoardId,
      cardId: duplicated.newCard.id,
      item: { type: "comment", data: wireComment },
    });
  }
  await syncMirrorActivities(mirror, source, duplicated.newCard);
  const linkPayload = {
    mirrorId: mirror.id,
    sourceCardId: source.id,
    sourceBoardId: mirror.sourceBoardId,
    targetCardId: duplicated.newCard.id,
    targetBoardId: mirror.targetBoardId,
  };
  await emitMirrorMetadataToBoards(mirror, SERVER_EVENTS.CARD_MIRROR_LINKED, linkPayload);
  return true;
}

async function detachDeletedSource(mirror: BoardMirror, sourceCardId: string, target: typeof cards.$inferSelect | null) {
  const cardLink = await findExternalLink({
    workspaceId: mirror.targetWorkspaceId,
    provider: providerFor(mirror),
    externalType: "card",
    externalId: sourceCardId,
  });
  const targetCardId = target?.id ?? (cardLink?.entityType === "card" ? cardLink.entityId : null);
  if (!targetCardId) return;
  await db.transaction(async (tx) => {
    const commentRows = target ? await tx.select({ id: comments.id }).from(comments).where(eq(comments.cardId, targetCardId)) : [];
    const attachmentRows = target ? await tx.select({ id: cardAttachments.id }).from(cardAttachments).where(eq(cardAttachments.cardId, targetCardId)) : [];
    const checklistRows = target ? await tx.select({ id: cardChecklists.id }).from(cardChecklists).where(eq(cardChecklists.cardId, targetCardId)) : [];
    const checklistIds = checklistRows.map((row) => row.id);
    const itemRows = checklistIds.length > 0
      ? await tx.select({ id: cardChecklistItems.id }).from(cardChecklistItems).where(inArray(cardChecklistItems.checklistId, checklistIds))
      : [];
    const sourceActivityRows = await tx.select({ id: activityEvents.id, entityId: activityEvents.entityId, payload: activityEvents.payload }).from(activityEvents).where(or(
      and(eq(activityEvents.entityType, "card"), eq(activityEvents.entityId, sourceCardId)),
      sql`${activityEvents.payload}->>'cardId' = ${sourceCardId}`,
    ));
    const sourceExternalEntityIds = new Set<string>([sourceCardId]);
    for (const activity of sourceActivityRows) {
      sourceExternalEntityIds.add(activity.entityId);
      const payload = activity.payload && typeof activity.payload === "object" && !Array.isArray(activity.payload) ? activity.payload as Record<string, unknown> : {};
      for (const key of ["commentId", "attachmentId", "checklistId", "itemId", "parentItemId"]) {
        if (typeof payload[key] === "string") sourceExternalEntityIds.add(payload[key] as string);
      }
    }
    const entityIds = [targetCardId, ...commentRows.map((row) => row.id), ...attachmentRows.map((row) => row.id), ...checklistIds, ...itemRows.map((row) => row.id)];
    // Source deletion ends synchronization but does not control the destination lifecycle. Keep
    // the copied card exactly as its owner left it and release all mirror-owned entity links.
    await tx.delete(externalLinks).where(and(
      eq(externalLinks.workspaceId, mirror.targetWorkspaceId),
      eq(externalLinks.provider, providerFor(mirror)),
      or(
        inArray(externalLinks.entityId, entityIds),
        inArray(externalLinks.externalId, [...sourceExternalEntityIds]),
        sourceActivityRows.length > 0
          ? and(eq(externalLinks.externalType, "activity"), inArray(externalLinks.externalId, sourceActivityRows.map((row) => row.id)))
          : undefined,
      ),
    ));
  });
  const payload = {
    mirrorId: mirror.id,
    sourceCardId,
    sourceBoardId: mirror.sourceBoardId,
    targetCardId,
    targetBoardId: mirror.targetBoardId,
  };
  await emitMirrorMetadataToBoards(mirror, SERVER_EVENTS.CARD_MIRROR_UNLINKED, payload);
}

async function convergeCore(mirror: BoardMirror, sourceCardId: string, source: typeof cards.$inferSelect | null, target: typeof cards.$inferSelect) {
  if (!source) return detachDeletedSource(mirror, sourceCardId, target);
  const actor = await mirrorActor(mirror);
  const [mapping, targetIsInMappedList, archiveCommentLink, mirrorArchiveLink] = await Promise.all([
    sourceListMapping(mirror.id, source.listId),
    targetListIsMapped(mirror.id, target.listId),
    findExternalLink({
      workspaceId: mirror.targetWorkspaceId,
      provider: providerFor(mirror),
      externalType: SOURCE_ARCHIVE_COMMENT_LINK_TYPE,
      externalId: sourceCardId,
    }),
    findExternalLink({
      workspaceId: mirror.targetWorkspaceId,
      provider: providerFor(mirror),
      externalType: TARGET_MIRROR_ARCHIVE_LINK_TYPE,
      externalId: sourceCardId,
    }),
  ]);
  // Archive lifecycle is source-driven but mirror-owned: the source can archive/unarchive the copy
  // only while this mirror is the one holding it archived (the marker link). A destination user who
  // archives the copy themselves leaves no marker and stays terminal; one who manually unarchives a
  // mirror-archived copy takes the decision back, so we drop the now-stale marker below.
  const archiving = Boolean(source.archivedAt) && !target.archivedAt && !mirrorArchiveLink;
  const unarchiving = !source.archivedAt && Boolean(target.archivedAt) && Boolean(mirrorArchiveLink);
  const staleMarker = Boolean(mirrorArchiveLink) && !target.archivedAt;
  const archivedAt = archiving ? new Date() : null;
  // List mappings decide where a mirror starts and coordinate moves while both cards remain in
  // mapped lanes. Once the destination card is deliberately moved elsewhere, its durable mirror
  // link—not its current list—keeps content syncing, and later source updates must not pull it back.
  // Never move during an archive change: an archived card stays put and reappears where it was on
  // unarchive, matching the native archive/unarchive routes.
  const shouldMove = Boolean(targetIsInMappedList && mapping && !mapping.archivedAt && mapping.targetListId !== target.listId && !target.archivedAt && !archiving);
  const cardChanged = source.title !== target.title
    || source.description !== target.description
    || source.completedAt?.getTime() !== target.completedAt?.getTime()
    || archiving
    || unarchiving
    || shouldMove;
  const result = await db.transaction(async (tx) => {
    let archiveComment: typeof comments.$inferSelect | null = null;
    let lifecycleActivity: ActivityEvent | null = null;
    let deletedNotifications: DeletedNotificationRef[] = [];
    let position = target.position;
    let rebalance = null;
    if (shouldMove && mapping) {
      const insert = await positionForLaneInsert({ boardId: mirror.targetBoardId, listId: mapping.targetListId, moving: { type: "card", id: target.id }, beforeItem: null, tx });
      position = insert.position;
      if (insert.needsRebalance) rebalance = await rebalanceBoardLane(mapping.targetListId, mirror.targetBoardId, tx);
    }
    if (source.archivedAt && !archiveCommentLink) {
      const [created] = await tx.insert(comments).values({
        cardId: target.id,
        authorId: mirror.createdById,
        authorKind: "system",
        apiKeyName: "Board mirror",
        body: SOURCE_ARCHIVED_COMMENT,
      }).returning();
      archiveComment = created!;
      await upsertExternalLink({
        workspaceId: mirror.targetWorkspaceId,
        provider: providerFor(mirror),
        externalType: SOURCE_ARCHIVE_COMMENT_LINK_TYPE,
        externalId: sourceCardId,
        entityType: "comment",
        entityId: archiveComment.id,
      }, tx);
      await recordActivity(tx, {
        boardId: mirror.targetBoardId,
        workspaceId: mirror.targetWorkspaceId,
        actorId: mirror.createdById,
        actorKind: "system",
        entityType: "comment",
        entityId: archiveComment.id,
        action: ACTIVITY_ACTION.CREATED,
        payload: { cardId: target.id, mirrorId: mirror.id, sourceCardId, sourceArchivedAt: source.archivedAt },
      });
    } else if (!source.archivedAt && archiveCommentLink) {
      // Unarchiving the source permits a future archive transition to leave a fresh note while the
      // historical comment remains part of the destination card's audit trail.
      await tx.delete(externalLinks).where(eq(externalLinks.id, archiveCommentLink.id));
    }
    if (archiving) {
      // Propagate the archive onto the target and record it as a first-class archive activity so the
      // destination feed reads exactly like a native archive (see cards/routes.ts archive route).
      await upsertExternalLink({
        workspaceId: mirror.targetWorkspaceId,
        provider: providerFor(mirror),
        externalType: TARGET_MIRROR_ARCHIVE_LINK_TYPE,
        externalId: sourceCardId,
        entityType: "card",
        entityId: target.id,
      }, tx);
      lifecycleActivity = await recordActivity(tx, {
        boardId: mirror.targetBoardId,
        workspaceId: mirror.targetWorkspaceId,
        actorId: mirror.createdById,
        actorKind: "system",
        entityType: "card",
        entityId: target.id,
        action: ACTIVITY_ACTION.ARCHIVED,
        payload: { title: source.title, archivedAt, mirrorId: mirror.id, sourceCardId },
      });
      deletedNotifications = await clearNotificationsForCards(tx, [target.id]);
    } else if (unarchiving) {
      await tx.delete(externalLinks).where(eq(externalLinks.id, mirrorArchiveLink!.id));
      lifecycleActivity = await recordActivity(tx, {
        boardId: mirror.targetBoardId,
        workspaceId: mirror.targetWorkspaceId,
        actorId: mirror.createdById,
        actorKind: "system",
        entityType: "card",
        entityId: target.id,
        action: ACTIVITY_ACTION.UNARCHIVED,
        payload: { title: source.title, archivedAt: null, mirrorId: mirror.id, sourceCardId },
      });
    } else if (staleMarker) {
      // The destination user manually unarchived a card this mirror had archived. Their live copy is
      // now their own again: drop the marker so a future manual archive is terminal. The single-worker
      // drain makes this deterministic; the only race is a manual unarchive landing mid-run, which the
      // next reconcile heals.
      await tx.delete(externalLinks).where(eq(externalLinks.id, mirrorArchiveLink!.id));
    }
    const [updated] = cardChanged
      ? await tx.update(cards).set({
        title: source.title,
        description: source.description,
        // Due date is an initial snapshot, not a managed mirror facet. Destination users can change
        // it after creation without a later source edit overwriting their planning decision.
        completedAt: source.completedAt,
        ...((archiving || unarchiving) && { archivedAt }),
        ...(shouldMove && mapping && { listId: mapping.targetListId, position }),
        updatedAt: new Date(),
      }).where(eq(cards.id, target.id)).returning()
      : [target];
    if (source.description !== target.description) await replaceCardMentions({ tx, boardId: mirror.targetBoardId, cardId: target.id, source: "description", markdown: source.description });
    return { updated: updated!, rebalance, archiveComment, lifecycleActivity, deletedNotifications };
  });
  // Rebalance must be visible before the corresponding move or clients can apply stale positions.
  if (result.rebalance && mapping) await emitLaneRebalanced(mirror.targetBoardId, mapping.targetListId, result.rebalance);
  if (shouldMove && mapping) await emitToBoard(mirror.targetBoardId, SERVER_EVENTS.CARD_MOVED, { boardId: mirror.targetBoardId, cardId: target.id, fromListId: target.listId, toListId: mapping.targetListId, position: result.updated.position, prevPosition: target.position });
  // The CARD_UPDATED payload now carries archivedAt, so target boards add/remove the card exactly as
  // the native archive route does when the mirror flips its lifecycle state.
  emitDeletedNotifications(result.deletedNotifications);
  if (cardChanged) await emitToBoard(mirror.targetBoardId, SERVER_EVENTS.CARD_UPDATED, { boardId: mirror.targetBoardId, card: toWireCard(result.updated, actor.cid) });
  if (result.lifecycleActivity) await emitActivityFeedItem(mirror.targetBoardId, target.id, result.lifecycleActivity, { notify: false });
  if (result.archiveComment) {
    const wireComment = { ...result.archiveComment, authorName: "Kanera", authorAvatarUrl: null, reactions: [] };
    await emitToBoard(mirror.targetBoardId, SERVER_EVENTS.COMMENT_CREATED, { boardId: mirror.targetBoardId, cardId: target.id, comment: wireComment });
    await emitToBoard(mirror.targetBoardId, SERVER_EVENTS.CARD_FEED_ITEM_CREATED, { boardId: mirror.targetBoardId, cardId: target.id, item: { type: "comment", data: wireComment } });
  }
}

async function convergeLabels(mirror: BoardMirror, sourceCardId: string, targetCardId: string) {
  const [sourceRows, targetRows] = await Promise.all([
    db.select({ labelId: cardLabelAssignments.labelId }).from(cardLabelAssignments).where(eq(cardLabelAssignments.cardId, sourceCardId)),
    db.select({ labelId: cardLabelAssignments.labelId }).from(cardLabelAssignments).where(eq(cardLabelAssignments.cardId, targetCardId)),
  ]);
  const labelIds = await duplicateLabelIds(sourceRows, { workspaceId: mirror.sourceWorkspaceId }, { workspaceId: mirror.targetWorkspaceId });
  const desired = new Set(labelIds);
  const current = new Set(targetRows.map((row) => row.labelId));
  const removed = [...current].filter((labelId) => !desired.has(labelId));
  const added = labelIds.filter((labelId) => !current.has(labelId));
  if (removed.length === 0 && added.length === 0) return;
  await db.transaction(async (tx) => {
    if (removed.length) await tx.delete(cardLabelAssignments).where(and(eq(cardLabelAssignments.cardId, targetCardId), inArray(cardLabelAssignments.labelId, removed)));
    if (added.length) await tx.insert(cardLabelAssignments).values(added.map((labelId) => ({ cardId: targetCardId, labelId })));
  });
  await emitToBoard(mirror.targetBoardId, SERVER_EVENTS.CARD_LABELS_SET, { boardId: mirror.targetBoardId, cardId: targetCardId, labelIds });
}

function stringArraysEqual(left: string[] | null, right: string[] | null): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function fieldValuesEqual(
  left: typeof cardCustomFieldValues.$inferSelect,
  right: Omit<typeof cardCustomFieldValues.$inferInsert, "cardId">,
): boolean {
  return left.valueText === (right.valueText ?? null)
    && left.valueNumber === (right.valueNumber ?? null)
    && left.valueCheckbox === (right.valueCheckbox ?? null)
    && left.valueDate === (right.valueDate ?? null)
    && left.valueUrl === (right.valueUrl ?? null)
    && stringArraysEqual(left.valueOptionIds, right.valueOptionIds ?? null)
    && stringArraysEqual(left.valueUserIds, right.valueUserIds ?? null);
}

async function convergeFields(mirror: BoardMirror, sourceCardId: string, targetCardId: string) {
  const [sourceValues, previous, sourceFieldRows, targetFieldRows] = await Promise.all([
    db.select().from(cardCustomFieldValues).where(eq(cardCustomFieldValues.cardId, sourceCardId)),
    db.select().from(cardCustomFieldValues).where(eq(cardCustomFieldValues.cardId, targetCardId)),
    db.select({ id: customFields.id, name: customFields.name, type: customFields.type }).from(customFields).where(and(eq(customFields.workspaceId, mirror.sourceWorkspaceId), isNull(customFields.archivedAt))),
    db.select({ id: customFields.id, name: customFields.name, type: customFields.type }).from(customFields).where(and(eq(customFields.workspaceId, mirror.targetWorkspaceId), isNull(customFields.archivedAt))),
  ]);
  const candidateUserIds = [...new Set(sourceValues.flatMap((value) => value.valueUserIds ?? []))];
  const eligibleUserRows = candidateUserIds.length
    ? await db.select({ userId: workspaceMembers.userId }).from(workspaceMembers).where(and(
      eq(workspaceMembers.workspaceId, mirror.targetWorkspaceId),
      inArray(workspaceMembers.userId, candidateUserIds),
    ))
    : [];
  const values = await duplicateCustomFieldValues(
    sourceValues,
    { workspaceId: mirror.sourceWorkspaceId },
    { workspaceId: mirror.targetWorkspaceId },
    eligibleUserRows.map((row) => row.userId),
  );
  const sourceKeys = new Set(sourceFieldRows.map((field) => `${field.name}\0${field.type}`));
  const managedTargetFieldIds = mirror.sourceWorkspaceId === mirror.targetWorkspaceId
    ? sourceFieldRows.map((field) => field.id)
    : targetFieldRows.filter((field) => sourceKeys.has(`${field.name}\0${field.type}`)).map((field) => field.id);
  const previousByField = new Map(previous.map((row) => [row.fieldId, row]));
  const nextIds = new Set(values.map((value) => value.fieldId));
  const managedIds = new Set(managedTargetFieldIds);
  const cleared = previous.filter((row) => managedIds.has(row.fieldId) && !nextIds.has(row.fieldId));
  const changed = values.filter((value) => {
    const row = previousByField.get(value.fieldId);
    return !row || !fieldValuesEqual(row, value);
  });
  if (cleared.length === 0 && changed.length === 0) return;
  await db.transaction(async (tx) => {
    if (cleared.length) await tx.delete(cardCustomFieldValues).where(and(
      eq(cardCustomFieldValues.cardId, targetCardId),
      inArray(cardCustomFieldValues.fieldId, cleared.map((row) => row.fieldId)),
    ));
    for (const value of changed) {
      await tx.insert(cardCustomFieldValues).values({ cardId: targetCardId, ...value }).onConflictDoUpdate({
        target: [cardCustomFieldValues.cardId, cardCustomFieldValues.fieldId],
        set: { ...value, updatedAt: new Date() },
      });
    }
  });
  for (const row of cleared) await emitToBoard(mirror.targetBoardId, SERVER_EVENTS.CARD_CUSTOM_FIELD_VALUE_CLEARED, { boardId: mirror.targetBoardId, cardId: targetCardId, fieldId: row.fieldId });
  for (const value of changed) await emitToBoard(mirror.targetBoardId, SERVER_EVENTS.CARD_CUSTOM_FIELD_VALUE_SET, { boardId: mirror.targetBoardId, cardId: targetCardId, ...value });
}

async function convergeComments(mirror: BoardMirror, sourceCardId: string, targetCardId: string) {
  const provider = providerFor(mirror);
  const sourceRows = await db
    .select({ comment: comments, authorName: sql<string>`case when ${comments.authorKind} in ('system', 'apiKey') then coalesce(${comments.apiKeyName}, ${users.displayName}) else ${users.displayName} end` })
    .from(comments)
    .innerJoin(users, eq(users.id, comments.authorId))
    .where(eq(comments.cardId, sourceCardId))
    .orderBy(asc(comments.createdAt));
  const targetRows = await db.select({ id: comments.id }).from(comments).where(eq(comments.cardId, targetCardId));
  const links = (await findExternalLinks({
    workspaceId: mirror.targetWorkspaceId,
    provider,
    externalTypes: ["comment"],
    externalIds: sourceRows.map((row) => row.comment.id),
    entityIds: targetRows.map((row) => row.id),
  })).filter((link) => link.entityType === "comment");
  const linkBySource = new Map(links.map((link) => [link.externalId, link]));
  const sourceIds = new Set(sourceRows.map((row) => row.comment.id));
  for (const link of links) {
    if (sourceIds.has(link.externalId)) continue;
    await db.delete(comments).where(and(eq(comments.id, link.entityId), eq(comments.cardId, targetCardId)));
    await deleteExternalLinks({ workspaceId: mirror.targetWorkspaceId, provider, externalType: "comment", externalId: link.externalId });
    await emitToBoard(mirror.targetBoardId, SERVER_EVENTS.COMMENT_DELETED, { boardId: mirror.targetBoardId, cardId: targetCardId, commentId: link.entityId });
    await emitToBoard(mirror.targetBoardId, SERVER_EVENTS.CARD_FEED_ITEM_DELETED, { boardId: mirror.targetBoardId, cardId: targetCardId, type: "comment", itemId: link.entityId });
  }
  for (const row of sourceRows) {
    const linked = linkBySource.get(row.comment.id);
    let targetComment: typeof comments.$inferSelect;
    let createdNow = !linked;
    if (linked) {
      const [existing] = await db.select().from(comments).where(and(eq(comments.id, linked.entityId), eq(comments.cardId, targetCardId))).limit(1);
      if (existing) {
        const unchanged = existing.body === row.comment.body
          && existing.editedAt?.getTime() === row.comment.editedAt?.getTime()
          && existing.authorKind === "system"
          && existing.apiKeyId === null
          && existing.apiKeyName === row.authorName;
        if (unchanged) continue;
        const [updated] = await db.update(comments).set({ body: row.comment.body, editedAt: row.comment.editedAt, authorKind: "system", apiKeyId: null, apiKeyName: row.authorName }).where(eq(comments.id, existing.id)).returning();
        targetComment = updated!;
      } else {
        // A target user may delete a mirrored entity. Drop the stale link and recreate from source
        // rather than letting that missing target permanently suppress future convergence.
        await deleteExternalLinks({ workspaceId: mirror.targetWorkspaceId, provider, externalType: "comment", externalId: row.comment.id });
        const [created] = await db.insert(comments).values({ cardId: targetCardId, authorId: mirror.createdById, authorKind: "system", apiKeyName: row.authorName, body: row.comment.body, editedAt: row.comment.editedAt, createdAt: row.comment.createdAt }).returning();
        targetComment = created!;
        createdNow = true;
        await upsertExternalLink({ workspaceId: mirror.targetWorkspaceId, provider, externalType: "comment", externalId: row.comment.id, entityType: "comment", entityId: targetComment.id });
      }
    } else {
      const [created] = await db.insert(comments).values({ cardId: targetCardId, authorId: mirror.createdById, authorKind: "system", apiKeyName: row.authorName, body: row.comment.body, editedAt: row.comment.editedAt, createdAt: row.comment.createdAt }).returning();
      targetComment = created!;
      await upsertExternalLink({ workspaceId: mirror.targetWorkspaceId, provider, externalType: "comment", externalId: row.comment.id, entityType: "comment", entityId: targetComment.id });
    }
    await replaceCardMentions({ tx: db, boardId: mirror.targetBoardId, cardId: targetCardId, commentId: targetComment.id, source: "comment", markdown: targetComment.body });
    const wireComment = {
      ...targetComment,
      authorName: "Kanera",
      authorAvatarUrl: null,
      reactions: [],
      mirrorId: mirror.id,
    };
    await emitToBoard(mirror.targetBoardId, createdNow ? SERVER_EVENTS.COMMENT_CREATED : SERVER_EVENTS.COMMENT_UPDATED, { boardId: mirror.targetBoardId, cardId: targetCardId, comment: wireComment });
    await emitToBoard(mirror.targetBoardId, createdNow ? SERVER_EVENTS.CARD_FEED_ITEM_CREATED : SERVER_EVENTS.CARD_FEED_ITEM_UPDATED, { boardId: mirror.targetBoardId, cardId: targetCardId, item: { type: "comment", data: wireComment } });
  }
}

async function convergeChecklists(mirror: BoardMirror, sourceCardId: string, targetCardId: string) {
  const provider = providerFor(mirror);
  const [source, target, targetCard] = await Promise.all([
    loadChecklistsForCard(sourceCardId),
    loadChecklistsForCard(targetCardId),
    db.select().from(cards).where(eq(cards.id, targetCardId)).limit(1).then((rows) => rows[0]),
  ]);
  if (!targetCard) return;
  const sourceChecklistIds = source.map((checklist) => checklist.id);
  const sourceItemIds = source.flatMap((checklist) => checklist.items.map((item) => item.id));
  const targetChecklistIds = target.map((checklist) => checklist.id);
  const targetItems = target.flatMap((checklist) => checklist.items);
  const links = await findExternalLinks({
    workspaceId: mirror.targetWorkspaceId,
    provider,
    externalTypes: ["cardChecklist", "cardChecklistItem"],
    externalIds: [...sourceChecklistIds, ...sourceItemIds],
    entityIds: [...targetChecklistIds, ...targetItems.map((item) => item.id)],
  });
  const checklistLinkBySource = new Map(links.filter((link) => link.externalType === "cardChecklist" && link.entityType === "cardChecklist").map((link) => [link.externalId, link]));
  const itemLinkBySource = new Map(links.filter((link) => link.externalType === "cardChecklistItem" && link.entityType === "cardChecklistItem").map((link) => [link.externalId, link]));
  const targetChecklistById = new Map(target.map((checklist) => [checklist.id, checklist]));
  const targetItemById = new Map(targetItems.map((item) => [item.id, item]));
  const sourceChecklistIdSet = new Set(sourceChecklistIds);
  const sourceItemIdSet = new Set(sourceItemIds);
  const linkedTargetChecklistIds = new Set([...checklistLinkBySource.values()].map((link) => link.entityId));
  const linkedTargetItemIds = new Set([...itemLinkBySource.values()].map((link) => link.entityId));

  const createdChecklistIds = new Set<string>();
  const updatedChecklistIds = new Set<string>();
  const checklistMoves: { id: string; prevPosition: string; parentItemId: string | null }[] = [];
  const deletedChecklistsById = new Map(links
    .filter((link) => link.externalType === "cardChecklist" && !sourceChecklistIdSet.has(link.externalId))
    .flatMap((link) => targetChecklistById.get(link.entityId) ? [targetChecklistById.get(link.entityId)!] : [])
    .map((checklist) => [checklist.id, checklist] as const));
  // Top-level destination-only checklists are independent content. Nested trees attached to a
  // source-managed item are source-authoritative, so a destination-only nested branch is removed
  // on the next structural source event just as the previous rebuild implementation did.
  for (const checklist of target) {
    if (checklist.parentItemId && linkedTargetItemIds.has(checklist.parentItemId) && !linkedTargetChecklistIds.has(checklist.id)) {
      deletedChecklistsById.set(checklist.id, checklist);
    }
  }
  const deletedChecklists = [...deletedChecklistsById.values()];
  const createdItemIds = new Set<string>();
  const updatedItemIds = new Set<string>();
  const itemMoves: { id: string; fromChecklistId: string; toChecklistId: string; prevPosition: string }[] = [];
  const deletedItemsById = new Map(links
    .filter((link) => link.externalType === "cardChecklistItem" && !sourceItemIdSet.has(link.externalId))
    .flatMap((link) => targetItemById.get(link.entityId) ? [targetItemById.get(link.entityId)!] : [])
    .map((item) => [item.id, item] as const));
  for (const item of targetItems) {
    if (linkedTargetChecklistIds.has(item.checklistId) && !linkedTargetItemIds.has(item.id)) deletedItemsById.set(item.id, item);
  }
  const deletedItems = [...deletedItemsById.values()];
  const targetChecklistIdBySource = new Map<string, string>();
  const targetItemIdBySource = new Map<string, string>();

  await db.transaction(async (tx) => {
    let changed = false;
    const ensureChecklist = async (sourceChecklist: (typeof source)[number], parentItemId: string | null) => {
      const linked = checklistLinkBySource.get(sourceChecklist.id);
      const existing = linked ? targetChecklistById.get(linked.entityId) : undefined;
      const targetId = existing?.id ?? randomUUID();
      targetChecklistIdBySource.set(sourceChecklist.id, targetId);
      if (!existing) {
        await tx.insert(cardChecklists).values({
          id: targetId,
          cardId: targetCardId,
          parentItemId,
          title: sourceChecklist.title,
          position: sourceChecklist.position,
        });
        createdChecklistIds.add(targetId);
        changed = true;
      } else {
        const titleChanged = existing.title !== sourceChecklist.title;
        const parentChanged = existing.parentItemId !== parentItemId;
        const positionChanged = existing.position !== sourceChecklist.position;
        if (titleChanged || parentChanged || positionChanged) {
          await tx.update(cardChecklists).set({
            ...(titleChanged && { title: sourceChecklist.title }),
            ...(parentChanged && { parentItemId }),
            ...(positionChanged && { position: sourceChecklist.position }),
            updatedAt: new Date(),
          }).where(eq(cardChecklists.id, existing.id));
          if (titleChanged || parentChanged) updatedChecklistIds.add(existing.id);
          if (positionChanged) checklistMoves.push({ id: existing.id, prevPosition: existing.position, parentItemId });
          changed = true;
        }
      }
      if (!linked || linked.entityType !== "cardChecklist" || linked.entityId !== targetId) {
        await upsertExternalLink({ workspaceId: mirror.targetWorkspaceId, provider, externalType: "cardChecklist", externalId: sourceChecklist.id, entityType: "cardChecklist", entityId: targetId }, tx);
      }
      return targetId;
    };

    const ensureItems = async (sourceChecklist: (typeof source)[number], checklistId: string) => {
      for (const sourceItem of sourceChecklist.items) {
        const linked = itemLinkBySource.get(sourceItem.id);
        const existing = linked ? targetItemById.get(linked.entityId) : undefined;
        const targetId = existing?.id ?? randomUUID();
        targetItemIdBySource.set(sourceItem.id, targetId);
        if (!existing) {
          await tx.insert(cardChecklistItems).values({
            id: targetId,
            checklistId,
            text: sourceItem.text,
            description: sourceItem.description,
            position: sourceItem.position,
            // Planning state becomes target-owned after the initial snapshot. New source items are
            // therefore structural/content copies only and always arrive ready to plan.
            assigneeId: null,
            completedAt: null,
            completedById: null,
            dueDateLocalDate: null,
            dueDateSlot: null,
            dueDateTimezone: null,
          });
          createdItemIds.add(targetId);
          changed = true;
        } else {
          const contentChanged = existing.text !== sourceItem.text || existing.description !== sourceItem.description;
          const checklistChanged = existing.checklistId !== checklistId;
          const positionChanged = existing.position !== sourceItem.position;
          if (contentChanged || checklistChanged || positionChanged) {
            await tx.update(cardChecklistItems).set({
              ...(contentChanged && { text: sourceItem.text, description: sourceItem.description }),
              ...(checklistChanged && { checklistId }),
              ...(positionChanged && { position: sourceItem.position }),
              updatedAt: new Date(),
            }).where(eq(cardChecklistItems.id, existing.id));
            if (contentChanged) updatedItemIds.add(existing.id);
            if (checklistChanged || positionChanged) itemMoves.push({ id: existing.id, fromChecklistId: existing.checklistId, toChecklistId: checklistId, prevPosition: existing.position });
            changed = true;
          }
        }
        if (!linked || linked.entityType !== "cardChecklistItem" || linked.entityId !== targetId) {
          await upsertExternalLink({ workspaceId: mirror.targetWorkspaceId, provider, externalType: "cardChecklistItem", externalId: sourceItem.id, entityType: "cardChecklistItem", entityId: targetId }, tx);
        }
      }
    };

    // Parent item mappings must exist before nested detail checklists can be re-parented.
    for (const sourceChecklist of source.filter((checklist) => checklist.parentItemId === null)) {
      const checklistId = await ensureChecklist(sourceChecklist, null);
      await ensureItems(sourceChecklist, checklistId);
    }
    for (const sourceChecklist of source.filter((checklist) => checklist.parentItemId !== null)) {
      const parentItemId = targetItemIdBySource.get(sourceChecklist.parentItemId!);
      if (!parentItemId) continue;
      const checklistId = await ensureChecklist(sourceChecklist, parentItemId);
      await ensureItems(sourceChecklist, checklistId);
    }

    // Retain identity links for deleted source-managed entities. Their target rows are removed
    // below, but the following activity facet still needs the stable target ids to rewrite deletion
    // history without leaking source ids. Provider cleanup removes these tombstones on detach.
    if (deletedItems.length) {
      await tx.delete(cardChecklistItems).where(inArray(cardChecklistItems.id, deletedItems.map((item) => item.id)));
      changed = true;
    }
    if (deletedChecklists.length) {
      await tx.delete(cardChecklists).where(inArray(cardChecklists.id, deletedChecklists.map((checklist) => checklist.id)));
      changed = true;
    }
    if (changed) await tx.update(cards).set({ updatedAt: new Date() }).where(eq(cards.id, targetCardId));
  });

  const final = await loadChecklistsForCard(targetCardId);
  const finalChecklistById = new Map(final.map((checklist) => [checklist.id, checklist]));
  const finalItemById = new Map(final.flatMap((checklist) => checklist.items.map((item) => [item.id, item] as const)));
  const deletedChecklistIds = new Set(deletedChecklists.map((checklist) => checklist.id));
  for (const item of deletedItems) {
    if (deletedChecklistIds.has(item.checklistId)) continue;
    const containing = targetChecklistById.get(item.checklistId);
    await emitToBoard(mirror.targetBoardId, SERVER_EVENTS.CARD_CHECKLIST_ITEM_DELETED, {
      boardId: mirror.targetBoardId,
      cardId: targetCardId,
      checklistId: item.checklistId,
      checklistParentItemId: containing?.parentItemId ?? null,
      itemId: item.id,
      completedAt: item.completedAt,
    });
  }
  for (const checklist of deletedChecklists) await emitToBoard(mirror.targetBoardId, SERVER_EVENTS.CARD_CHECKLIST_DELETED, { boardId: mirror.targetBoardId, cardId: targetCardId, checklistId: checklist.id });
  for (const id of createdChecklistIds) {
    const checklist = finalChecklistById.get(id);
    if (checklist) await emitToBoard(mirror.targetBoardId, SERVER_EVENTS.CARD_CHECKLIST_CREATED, { boardId: mirror.targetBoardId, cardId: targetCardId, checklist });
  }
  for (const id of updatedChecklistIds) {
    const checklist = finalChecklistById.get(id);
    if (checklist) await emitToBoard(mirror.targetBoardId, SERVER_EVENTS.CARD_CHECKLIST_UPDATED, { boardId: mirror.targetBoardId, cardId: targetCardId, checklist });
  }
  const checklistMoveGroups = groupBy(checklistMoves, (move) => move.parentItemId ?? "top");
  for (const moves of checklistMoveGroups.values()) {
    if (moves.length < 2) continue;
    const positions = final.filter((checklist) => (checklist.parentItemId ?? "top") === (moves[0]!.parentItemId ?? "top")).map((checklist) => ({ id: checklist.id, position: checklist.position }));
    await emitToBoard(mirror.targetBoardId, SERVER_EVENTS.CARD_CHECKLIST_REBALANCED, { boardId: mirror.targetBoardId, cardId: targetCardId, positions });
  }
  for (const move of checklistMoves) {
    const checklist = finalChecklistById.get(move.id);
    if (checklist) await emitToBoard(mirror.targetBoardId, SERVER_EVENTS.CARD_CHECKLIST_MOVED, { boardId: mirror.targetBoardId, cardId: targetCardId, checklistId: move.id, position: checklist.position, prevPosition: move.prevPosition });
  }
  for (const id of createdItemIds) {
    const item = finalItemById.get(id);
    if (!item || createdChecklistIds.has(item.checklistId)) continue;
    const checklist = finalChecklistById.get(item.checklistId);
    if (!checklist) continue;
    await emitToBoard(mirror.targetBoardId, SERVER_EVENTS.CARD_CHECKLIST_ITEM_CREATED, { boardId: mirror.targetBoardId, cardId: targetCardId, cardTitle: targetCard.title, listId: targetCard.listId, checklistId: checklist.id, checklistParentItemId: checklist.parentItemId, item });
  }
  for (const id of updatedItemIds) {
    const item = finalItemById.get(id);
    if (!item) continue;
    const checklist = finalChecklistById.get(item.checklistId);
    const previous = targetItemById.get(id);
    if (!checklist || !previous) continue;
    await emitToBoard(mirror.targetBoardId, SERVER_EVENTS.CARD_CHECKLIST_ITEM_UPDATED, { boardId: mirror.targetBoardId, cardId: targetCardId, cardTitle: targetCard.title, listId: targetCard.listId, checklistId: checklist.id, checklistParentItemId: checklist.parentItemId, item, prevCompletedAt: previous.completedAt });
  }
  const itemMoveGroups = groupBy(itemMoves, (move) => move.toChecklistId);
  for (const [checklistId, moves] of itemMoveGroups) {
    if (moves.length < 2) continue;
    const positions = finalChecklistById.get(checklistId)?.items.map((item) => ({ id: item.id, position: item.position })) ?? [];
    await emitToBoard(mirror.targetBoardId, SERVER_EVENTS.CARD_CHECKLIST_ITEM_REBALANCED, { boardId: mirror.targetBoardId, cardId: targetCardId, checklistId, positions });
  }
  for (const move of itemMoves) {
    const item = finalItemById.get(move.id);
    if (item) await emitToBoard(mirror.targetBoardId, SERVER_EVENTS.CARD_CHECKLIST_ITEM_MOVED, { boardId: mirror.targetBoardId, cardId: targetCardId, itemId: item.id, fromChecklistId: move.fromChecklistId, toChecklistId: item.checklistId, position: item.position, prevPosition: move.prevPosition });
  }
}

async function convergeAttachments(mirror: BoardMirror, sourceCardId: string, targetCardId: string) {
  const provider = providerFor(mirror);
  const actor = await mirrorActor(mirror);
  const [sourceWorkspace] = await db.select({ clientId: workspaces.clientId }).from(workspaces).where(eq(workspaces.id, mirror.sourceWorkspaceId)).limit(1);
  if (!sourceWorkspace) throw new Error("board mirror source workspace no longer exists");
  const [sourceRows, targetRows] = await Promise.all([
    db.select().from(cardAttachments).where(eq(cardAttachments.cardId, sourceCardId)),
    db.select().from(cardAttachments).where(eq(cardAttachments.cardId, targetCardId)),
  ]);
  const sourceCommentIds = sourceRows.flatMap((attachment) => attachment.commentId ? [attachment.commentId] : []);
  const providerLinks = await findExternalLinks({
    workspaceId: mirror.targetWorkspaceId,
    provider,
    externalTypes: ["cardAttachment", "comment"],
    externalIds: [...sourceRows.map((attachment) => attachment.id), ...sourceCommentIds],
    entityIds: targetRows.map((attachment) => attachment.id),
  });
  const sourceById = new Map(sourceRows.map((attachment) => [attachment.id, attachment]));
  const targetById = new Map(targetRows.map((attachment) => [attachment.id, attachment]));
  const links = providerLinks.filter((link) => link.externalType === "cardAttachment" && link.entityType === "cardAttachment");
  const linkBySource = new Map(links.map((link) => [link.externalId, link]));
  const commentTargetIdBySource = new Map(providerLinks.filter((link) => link.externalType === "comment" && link.entityType === "comment").map((link) => [link.externalId, link.entityId]));
  const destinationStorage = await getStorageForClient(actor.cid);
  const [uploader] = await db.select({ displayName: users.displayName, avatarUrl: users.avatarUrl }).from(users).where(eq(users.id, mirror.createdById)).limit(1);
  const wireAttachment = (attachment: typeof cardAttachments.$inferSelect): CardAttachmentRow => {
    const shaped = shapeAttachmentMedia(attachment);
    return {
      id: attachment.id,
      cardId: targetCardId,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      byteSize: attachment.byteSize,
      url: shaped.url,
      thumbnailUrl: shaped.thumbnailUrl,
      coverImageWidth: attachment.coverImageWidth,
      coverImageHeight: attachment.coverImageHeight,
      coverImageColor: attachment.coverImageColor,
      createdAt: attachment.createdAt,
      uploadedById: attachment.uploadedById,
      uploadedByName: uploader?.displayName ?? "Board mirror",
      uploadedByAvatarUrl: withSignedMedia(actor.cid, { uploadedByAvatarUrl: uploader?.avatarUrl ?? null }).uploadedByAvatarUrl,
      source: attachment.source,
      commentId: attachment.commentId,
    };
  };

  for (const link of links) {
    const source = sourceById.get(link.externalId);
    const target = targetById.get(link.entityId);
    if (source && target) {
      const commentId = source.commentId ? commentTargetIdBySource.get(source.commentId) ?? null : null;
      const attachmentSource = source.source === "comment" && commentId ? "comment" : source.source === "comment" ? "attachment" : source.source;
      const metadataChanged = target.fileName !== source.fileName
        || target.mimeType !== source.mimeType
        || target.byteSize !== source.byteSize
        || target.coverImageWidth !== source.coverImageWidth
        || target.coverImageHeight !== source.coverImageHeight
        || target.coverImageColor !== source.coverImageColor
        || target.source !== attachmentSource
        || target.commentId !== commentId
        || target.uploadedById !== mirror.createdById;
      if (metadataChanged) {
        const [updated] = await db.update(cardAttachments).set({
          fileName: source.fileName,
          mimeType: source.mimeType,
          byteSize: source.byteSize,
          coverImageWidth: source.coverImageWidth,
          coverImageHeight: source.coverImageHeight,
          coverImageColor: source.coverImageColor,
          uploadedById: mirror.createdById,
          source: attachmentSource,
          commentId,
        }).where(eq(cardAttachments.id, target.id)).returning();
        if (updated) await emitToBoard(mirror.targetBoardId, SERVER_EVENTS.CARD_ATTACHMENT_CREATED, { boardId: mirror.targetBoardId, cardId: targetCardId, attachment: wireAttachment(updated) });
      }
      continue;
    }
    if (sourceById.has(link.externalId) && !targetById.has(link.entityId)) {
      await deleteExternalLinks({ workspaceId: mirror.targetWorkspaceId, provider, externalType: "cardAttachment", externalId: link.externalId });
      linkBySource.delete(link.externalId);
      continue;
    }
    if (target) {
      await db.delete(cardAttachments).where(and(eq(cardAttachments.id, target.id), eq(cardAttachments.cardId, targetCardId)));
      await Promise.allSettled([
        destinationStorage.delete(target.fileKey),
        target.thumbnailFileKey ? destinationStorage.delete(target.thumbnailFileKey) : Promise.resolve(),
        target.coverImageFileKey ? destinationStorage.delete(target.coverImageFileKey) : Promise.resolve(),
      ]);
      await emitToBoard(mirror.targetBoardId, SERVER_EVENTS.CARD_ATTACHMENT_DELETED, { boardId: mirror.targetBoardId, cardId: targetCardId, attachmentId: target.id });
    }
    // Keep the identity tombstone so the following activity facet can remap attachment-removal
    // history even though the preview row itself no longer exists.
  }

  const sourceStorage = await getStorageForClient(sourceWorkspace.clientId);
  for (const source of sourceRows) {
    if (linkBySource.has(source.id)) continue;
    await assertCanUploadAttachment(db, actor.cid, source.byteSize);
    const copy = await copyAttachmentBlobs(sourceStorage, destinationStorage, actor.cid, source, targetCardId);
    try {
      const commentId = source.commentId ? commentTargetIdBySource.get(source.commentId) ?? null : null;
      const [created] = await db.transaction(async (tx) => {
        const rows = await tx.insert(cardAttachments).values({
          cardId: targetCardId,
          clientId: actor.cid,
          uploadedById: mirror.createdById,
          fileName: source.fileName,
          mimeType: source.mimeType,
          byteSize: source.byteSize,
          fileKey: copy.fileKey,
          url: copy.url,
          thumbnailFileKey: copy.thumbnailFileKey,
          thumbnailUrl: copy.thumbnailUrl,
          coverImageFileKey: copy.coverImageFileKey,
          coverImageUrl: copy.coverImageUrl,
          coverImageWidth: copy.coverImageFileKey ? source.coverImageWidth : null,
          coverImageHeight: copy.coverImageFileKey ? source.coverImageHeight : null,
          coverImageColor: copy.coverImageFileKey ? source.coverImageColor : null,
          source: source.source === "comment" && commentId ? "comment" : source.source === "comment" ? "attachment" : source.source,
          commentId,
        }).returning();
        await upsertExternalLink({ workspaceId: mirror.targetWorkspaceId, provider, externalType: "cardAttachment", externalId: source.id, entityType: "cardAttachment", entityId: rows[0]!.id }, tx);
        return rows;
      });
      await emitToBoard(mirror.targetBoardId, SERVER_EVENTS.CARD_ATTACHMENT_CREATED, {
        boardId: mirror.targetBoardId,
        cardId: targetCardId,
        attachment: wireAttachment(created!),
      });
    } catch (error) {
      await Promise.allSettled([
        destinationStorage.delete(copy.fileKey),
        copy.thumbnailFileKey ? destinationStorage.delete(copy.thumbnailFileKey) : Promise.resolve(),
        copy.coverImageFileKey ? destinationStorage.delete(copy.coverImageFileKey) : Promise.resolve(),
      ]);
      throw error;
    }
  }
}

function sourceActivityActorName(row: {
  actorKind: ActivityEvent["actorKind"];
  actorNameSnapshot: string | null;
  apiKeyName: string | null;
  supportActorEmail: string | null;
}): string | null {
  if (row.actorKind === "system") return null;
  if (row.actorKind === "apiKey") return row.apiKeyName ?? "API key";
  if (row.actorKind === "support") return `Kanera Support (${row.supportActorEmail ?? "operator"})`;
  return row.actorNameSnapshot ?? "Unknown";
}

async function syncMirrorActivities(
  mirror: BoardMirror,
  source: typeof cards.$inferSelect,
  target: typeof cards.$inferSelect,
) {
  const provider = providerFor(mirror);
  const [sourceActivities, targetActivities, sourceLists, sourceFieldRows, targetFieldRows, sourceLabelRows, targetLabelRows] = await Promise.all([
    db
      .select({
        activity: activityEvents,
        actorNameSnapshot: users.displayName,
      })
      .from(activityEvents)
      .leftJoin(users, eq(users.id, activityEvents.actorId))
      .where(and(
        eq(activityEvents.boardId, mirror.sourceBoardId),
        or(
          and(eq(activityEvents.entityType, "card"), eq(activityEvents.entityId, source.id)),
          sql`${activityEvents.payload}->>'cardId' = ${source.id}`,
        ),
      ))
      .orderBy(asc(activityEvents.createdAt)),
    db.select().from(activityEvents).where(and(
      eq(activityEvents.boardId, mirror.targetBoardId),
      or(
        and(eq(activityEvents.entityType, "card"), eq(activityEvents.entityId, target.id)),
        sql`${activityEvents.payload}->>'cardId' = ${target.id}`,
      ),
    )),
    db.select({ id: lists.id, name: lists.name }).from(lists).where(eq(lists.workspaceId, mirror.sourceWorkspaceId)),
    db.select({ id: customFields.id, name: customFields.name, type: customFields.type }).from(customFields).where(and(eq(customFields.workspaceId, mirror.sourceWorkspaceId), isNull(customFields.archivedAt))),
    db.select({ id: customFields.id, name: customFields.name, type: customFields.type }).from(customFields).where(and(eq(customFields.workspaceId, mirror.targetWorkspaceId), isNull(customFields.archivedAt))),
    db.select({ id: cardLabels.id, name: cardLabels.name }).from(cardLabels).where(and(eq(cardLabels.workspaceId, mirror.sourceWorkspaceId), isNull(cardLabels.archivedAt))),
    db.select({ id: cardLabels.id, name: cardLabels.name }).from(cardLabels).where(and(eq(cardLabels.workspaceId, mirror.targetWorkspaceId), isNull(cardLabels.archivedAt))),
  ]);
  const referencedIds = sourceActivities.flatMap(({ activity }) => {
    const payload = activity.payload && typeof activity.payload === "object" && !Array.isArray(activity.payload)
      ? activity.payload as Record<string, unknown>
      : {};
    return ["attachmentId", "commentId", "checklistId", "itemId", "parentItemId"]
      .flatMap((key) => typeof payload[key] === "string" ? [payload[key] as string] : []);
  });
  const providerLinks = await findExternalLinks({
    workspaceId: mirror.targetWorkspaceId,
    provider,
    externalTypes: ["activity", "comment", "cardAttachment", "cardChecklist", "cardChecklistItem"],
    externalIds: [...sourceActivities.map(({ activity }) => activity.id), ...referencedIds],
    entityIds: targetActivities.map((activity) => activity.id),
  });
  const linksByActivityId = new Map(providerLinks.filter((link) => link.externalType === "activity" && link.entityType === "activity").map((link) => [link.externalId, link]));
  const entityLinks = new Map(providerLinks.map((link) => [`${link.externalType}:${link.externalId}`, link.entityId]));
  const listNames = new Map(sourceLists.map((list) => [list.id, list.name]));
  const targetActivityById = new Map(targetActivities.map((activity) => [activity.id, activity]));
  const targetFieldByKey = new Map(targetFieldRows.map((field) => [`${field.name}\0${field.type}`, field.id]));
  const fieldIdMap = new Map(sourceFieldRows.flatMap((field) => {
    const targetId = mirror.sourceWorkspaceId === mirror.targetWorkspaceId ? field.id : targetFieldByKey.get(`${field.name}\0${field.type}`);
    return targetId ? [[field.id, targetId] as const] : [];
  }));
  const targetLabelByName = new Map(targetLabelRows.map((label) => [label.name, label.id]));
  const labelIdMap = new Map(sourceLabelRows.flatMap((label) => {
    const targetId = mirror.sourceWorkspaceId === mirror.targetWorkspaceId ? label.id : targetLabelByName.get(label.name);
    return targetId ? [[label.id, targetId] as const] : [];
  }));
  const [sourceOptionRows, targetOptionRows] = await Promise.all([
    sourceFieldRows.length ? db.select({ id: customFieldOptions.id, fieldId: customFieldOptions.fieldId, label: customFieldOptions.label }).from(customFieldOptions).where(and(inArray(customFieldOptions.fieldId, sourceFieldRows.map((field) => field.id)), isNull(customFieldOptions.archivedAt))) : [],
    targetFieldRows.length ? db.select({ id: customFieldOptions.id, fieldId: customFieldOptions.fieldId, label: customFieldOptions.label }).from(customFieldOptions).where(and(inArray(customFieldOptions.fieldId, targetFieldRows.map((field) => field.id)), isNull(customFieldOptions.archivedAt))) : [],
  ]);
  const targetOptionByFieldAndLabel = new Map(targetOptionRows.map((option) => [`${option.fieldId}\0${option.label}`, option.id]));
  const optionIdMap = new Map(sourceOptionRows.flatMap((option) => {
    const targetFieldId = fieldIdMap.get(option.fieldId);
    const targetId = targetFieldId ? targetOptionByFieldAndLabel.get(`${targetFieldId}\0${option.label}`) : undefined;
    return targetId ? [[option.id, targetId] as const] : [];
  }));

  const deleteMappedActivity = async (sourceActivityId: string) => {
    const linked = linksByActivityId.get(sourceActivityId);
    if (!linked) return;
    const previous = targetActivityById.get(linked.entityId);
    await db.transaction(async (tx) => {
      await tx.delete(activityEvents).where(eq(activityEvents.id, linked.entityId));
      await tx.delete(externalLinks).where(eq(externalLinks.id, linked.id));
    });
    if (previous?.feedVisible) await emitActivityFeedItemDeleted(mirror.targetBoardId, target.id, previous.id);
    linksByActivityId.delete(sourceActivityId);
  };

  const mapPayloadId = (payload: Record<string, unknown>, key: string, externalType: string): boolean => {
    const value = payload[key];
    if (typeof value !== "string") return true;
    const mapped = entityLinks.get(`${externalType}:${value}`);
    if (!mapped) return false;
    payload[key] = mapped;
    return true;
  };

  const mapIdArray = (value: unknown, ids: Map<string, string>): string[] | null => {
    if (!Array.isArray(value)) return null;
    const sourceIds = value.filter((entry): entry is string => typeof entry === "string");
    if (sourceIds.length !== value.length) return null;
    const mapped = sourceIds.map((id) => ids.get(id));
    return mapped.every((id): id is string => Boolean(id)) ? mapped : null;
  };

  activityLoop: for (const row of sourceActivities) {
    const sourceActivity = row.activity;
    // Comments are already first-class feed cards and the mirror converges their full content,
    // authorship snapshot, edit marker, and deletion in convergeComments().
    if (sourceActivity.entityType === "comment"
      || sourceActivity.action === ACTIVITY_ACTION.CREATED
      // Archive/unarchive are re-recorded as first-class activities on the target by convergeCore;
      // copying the source's would duplicate them in the destination feed.
      || sourceActivity.action === ACTIVITY_ACTION.ARCHIVED
      || sourceActivity.action === ACTIVITY_ACTION.UNARCHIVED
      || sourceActivity.action === ACTIVITY_ACTION.COVER_SET
      || sourceActivity.action === ACTIVITY_ACTION.COVER_REMOVED
      || sourceActivity.action === ACTIVITY_ACTION.ASSIGNEES_SET
      || sourceActivity.action === ACTIVITY_ACTION.CHECKLIST_COMPLETED
      || sourceActivity.action === ACTIVITY_ACTION.CHECKLIST_ITEM_COMPLETION
      || sourceActivity.action === ACTIVITY_ACTION.CHECKLIST_ITEM_ASSIGNEE_SET
      || sourceActivity.action === ACTIVITY_ACTION.CHECKLIST_ITEM_DUE_DATE_SET
      || sourceActivity.coalesceKey === "card:assignees"
      || sourceActivity.coalesceKey === "card:mirrorSync") {
      await deleteMappedActivity(sourceActivity.id);
      continue;
    }

    const linked = linksByActivityId.get(sourceActivity.id);

    const sourcePayload = sourceActivity.payload && typeof sourceActivity.payload === "object" && !Array.isArray(sourceActivity.payload)
      ? sourceActivity.payload as Record<string, unknown>
      : {};
    const hasDueDateChange = "dueDateLocalDate" in sourcePayload || "dueDateSlot" in sourcePayload || "dueDateTimezone" in sourcePayload;
    const hasOtherCardChange = "title" in sourcePayload || "description" in sourcePayload;
    if (sourceActivity.action === ACTIVITY_ACTION.UPDATED && hasDueDateChange && !hasOtherCardChange) {
      await deleteMappedActivity(sourceActivity.id);
      continue;
    }
    const payload: Record<string, unknown> = { ...sourcePayload, mirrorId: mirror.id };
    // Mixed card edits still contribute their title/description audit entry, but must not imply
    // that the independently managed destination due date changed with the source.
    if (sourceActivity.action === ACTIVITY_ACTION.UPDATED && hasDueDateChange) {
      delete payload.dueDateLocalDate;
      delete payload.dueDateSlot;
      delete payload.dueDateTimezone;
    }
    if (payload.cardId === source.id) payload.cardId = target.id;
    const fromListId = typeof payload.fromListId === "string" ? payload.fromListId : null;
    const toListId = typeof payload.toListId === "string" ? payload.toListId : null;
    if (fromListId && !payload.fromListName) payload.fromListName = listNames.get(fromListId) ?? null;
    if (toListId && !payload.toListName) payload.toListName = listNames.get(toListId) ?? null;
    if (typeof payload.listId === "string" && !payload.listName) payload.listName = listNames.get(payload.listId) ?? null;
    const identityMapped = mapPayloadId(payload, "attachmentId", "cardAttachment")
      && mapPayloadId(payload, "commentId", "comment")
      && mapPayloadId(payload, "checklistId", "cardChecklist")
      && mapPayloadId(payload, "itemId", "cardChecklistItem")
      && mapPayloadId(payload, "parentItemId", "cardChecklistItem");
    if (!identityMapped) {
      await deleteMappedActivity(sourceActivity.id);
      continue;
    }
    if (typeof payload.fieldId === "string") {
      const mapped = fieldIdMap.get(payload.fieldId);
      if (!mapped) {
        await deleteMappedActivity(sourceActivity.id);
        continue;
      }
      payload.fieldId = mapped;
    }
    if (sourceActivity.action === ACTIVITY_ACTION.LABELS_SET) {
      let valid = true;
      for (const key of ["labelIds", "fromValue", "toValue"]) {
        if (!Array.isArray(payload[key])) continue;
        const mapped = mapIdArray(payload[key], labelIdMap);
        if (!mapped) { valid = false; break; }
        payload[key] = mapped;
      }
      if (!valid) {
        await deleteMappedActivity(sourceActivity.id);
        continue;
      }
    }
    for (const key of ["optionId", "valueOptionId"]) {
      if (typeof payload[key] !== "string") continue;
      const mapped = optionIdMap.get(payload[key] as string);
      if (!mapped) {
        await deleteMappedActivity(sourceActivity.id);
        continue activityLoop;
      }
      payload[key] = mapped;
    }
    for (const key of ["optionIds", "valueOptionIds"]) {
      if (!Array.isArray(payload[key])) continue;
      const mapped = mapIdArray(payload[key], optionIdMap);
      if (!mapped) {
        await deleteMappedActivity(sourceActivity.id);
        continue activityLoop;
      }
      payload[key] = mapped;
    }
    const previousTargetActivity = linked?.entityType === "activity" ? targetActivityById.get(linked.entityId) : undefined;
    const previousPayload = previousTargetActivity?.payload && typeof previousTargetActivity.payload === "object" && !Array.isArray(previousTargetActivity.payload)
      ? previousTargetActivity.payload as Record<string, unknown>
      : {};
    // Snapshot the source display name the first time the activity is mirrored. Subsequent profile
    // edits or coalesced source updates cannot rewrite the historical actor shown on the target.
    const copiedActorName = typeof previousPayload.copiedActorName === "string"
      ? previousPayload.copiedActorName
      : typeof sourcePayload.copiedActorName === "string"
      ? sourcePayload.copiedActorName
      : sourceActivityActorName({ ...sourceActivity, actorNameSnapshot: row.actorNameSnapshot });
    if (copiedActorName) payload.copiedActorName = copiedActorName;

    const targetActivityId = linked?.entityType === "activity" ? linked.entityId : randomUUID();
    let entityId = sourceActivity.entityId;
    if (sourceActivity.entityType === "card" && entityId === source.id) entityId = target.id;
    else if (sourceActivity.entityType === "customField") {
      const mapped = fieldIdMap.get(entityId);
      if (!mapped) { await deleteMappedActivity(sourceActivity.id); continue; }
      entityId = mapped;
    } else if (sourceActivity.entityType === "cardLabel") {
      const mapped = labelIdMap.get(entityId);
      if (!mapped) { await deleteMappedActivity(sourceActivity.id); continue; }
      entityId = mapped;
    }
    let coalesceKey = sourceActivity.coalesceKey;
    if (coalesceKey?.startsWith("customField:")) {
      const mapped = fieldIdMap.get(coalesceKey.slice("customField:".length));
      if (!mapped) { await deleteMappedActivity(sourceActivity.id); continue; }
      coalesceKey = `customField:${mapped}`;
    } else if (coalesceKey?.startsWith("checklist:")) {
      const parts = coalesceKey.split(":");
      const mapped = entityLinks.get(`cardChecklist:${parts[1]}`);
      if (mapped) coalesceKey = [parts[0], mapped, ...parts.slice(2)].join(":");
    } else if (coalesceKey?.startsWith("checklistItem:")) {
      const parts = coalesceKey.split(":");
      const mapped = entityLinks.get(`cardChecklistItem:${parts[1]}`);
      if (mapped) coalesceKey = [parts[0], mapped, ...parts.slice(2)].join(":");
    }
    const [targetActivity] = await db.transaction(async (tx) => {
      const values = {
        boardId: mirror.targetBoardId,
        workspaceId: mirror.targetWorkspaceId,
        actorId: mirror.createdById,
        actorKind: "system" as const,
        apiKeyId: null,
        apiKeyName: null,
        supportSessionId: null,
        supportActorEmail: null,
        entityType: sourceActivity.entityType,
        entityId,
        action: sourceActivity.action,
        payload,
        feedVisible: sourceActivity.feedVisible,
        coalesceKey,
        coalescedCount: sourceActivity.coalescedCount,
        coalescedUntil: sourceActivity.coalescedUntil,
        updatedAt: sourceActivity.updatedAt,
      };
      const unchanged = previousTargetActivity
        && previousTargetActivity.entityType === values.entityType
        && previousTargetActivity.entityId === values.entityId
        && previousTargetActivity.action === values.action
        && previousTargetActivity.feedVisible === values.feedVisible
        && previousTargetActivity.coalesceKey === values.coalesceKey
        && previousTargetActivity.coalescedCount === values.coalescedCount
        && previousTargetActivity.coalescedUntil?.getTime() === values.coalescedUntil?.getTime()
        && JSON.stringify(previousTargetActivity.payload) === JSON.stringify(values.payload);
      const rows = unchanged
        ? [previousTargetActivity]
        : previousTargetActivity
        ? await tx.update(activityEvents).set(values).where(eq(activityEvents.id, targetActivityId)).returning()
        : await tx.insert(activityEvents).values({ id: targetActivityId, ...values, createdAt: sourceActivity.createdAt }).returning();
      if (!linked || linked.entityType !== "activity" || linked.entityId !== targetActivityId) {
        await upsertExternalLink({
          workspaceId: mirror.targetWorkspaceId,
          provider,
          externalType: "activity",
          externalId: sourceActivity.id,
          entityType: "activity",
          entityId: targetActivityId,
        }, tx);
      }
      return rows;
    });
    if (!targetActivity) continue;
    targetActivityById.set(targetActivity.id, targetActivity);
    const activityChanged = !previousTargetActivity
      || previousTargetActivity.feedVisible !== targetActivity.feedVisible
      || previousTargetActivity.updatedAt.getTime() !== targetActivity.updatedAt.getTime()
      || JSON.stringify(previousTargetActivity.payload) !== JSON.stringify(targetActivity.payload);
    if (!activityChanged) continue;
    if (!targetActivity.feedVisible) {
      if (previousTargetActivity?.feedVisible) await emitActivityFeedItemDeleted(mirror.targetBoardId, target.id, targetActivity.id);
    } else if (previousTargetActivity?.feedVisible) {
      await emitActivityFeedItemUpdated(mirror.targetBoardId, target.id, targetActivity, { notify: false });
    } else {
      await emitActivityFeedItem(mirror.targetBoardId, target.id, targetActivity, { notify: false });
    }
  }

  const currentSourceIds = new Set(sourceActivities.map(({ activity }) => activity.id));
  for (const [sourceActivityId] of linksByActivityId) {
    if (!currentSourceIds.has(sourceActivityId)) await deleteMappedActivity(sourceActivityId);
  }
}

async function convergeFacet(mirror: BoardMirror, sourceCardId: string, facet: BoardMirrorFacet) {
  if (facet === "link") {
    await linkSourceCard(mirror, sourceCardId);
    return;
  }
  const [source] = await db.select().from(cards).where(and(eq(cards.id, sourceCardId), eq(cards.boardId, mirror.sourceBoardId))).limit(1);
  const target = await targetCardFor(mirror, sourceCardId);
  if (!target) {
    if (source) await linkSourceCard(mirror, sourceCardId);
    else await detachDeletedSource(mirror, sourceCardId, null);
    return;
  }
  // Source deletion always ends the relationship, even when the destination card was manually
  // archived and is otherwise terminal for content convergence.
  if (!source && facet === "core") return convergeCore(mirror, sourceCardId, null, target);
  // Archiving a destination copy is terminal unless the mirror owns that state. A mirror-archived
  // copy accepts core so it can unarchive; the unarchive widening below then catches up every facet.
  // A user-archived copy has no marker and ignores every facet.
  if (target.archivedAt) {
    const marker = await findExternalLink({
      workspaceId: mirror.targetWorkspaceId,
      provider: providerFor(mirror),
      externalType: TARGET_MIRROR_ARCHIVE_LINK_TYPE,
      externalId: sourceCardId,
    });
    if (!marker || facet !== "core") return;
  }
  if (!source || facet === "core") return convergeCore(mirror, sourceCardId, source ?? null, target);
  if (facet === "labels") return convergeLabels(mirror, sourceCardId, target.id);
  if (facet === "fields") return convergeFields(mirror, sourceCardId, target.id);
  if (facet === "comments") return convergeComments(mirror, sourceCardId, target.id);
  if (facet === "attachments") return convergeAttachments(mirror, sourceCardId, target.id);
  if (facet === "checklists") return convergeChecklists(mirror, sourceCardId, target.id);
  if (facet === "activities") return syncMirrorActivities(mirror, source, target);
  // Blob IO occurs before each attachment DB transaction; the helper cleans copied keys on failure.
}

export async function convergeSourceCard(mirror: BoardMirror, sourceCardId: string, facets: BoardMirrorFacet[]) {
  // Unarchive catch-up: when the source went live again while the target is still mirror-archived,
  // the narrow dirty facets can miss content edited during the archived window. Widen to a full sync
  // so core unarchives first (it runs first in ALL_SYNC_FACETS) and every later facet re-reads the
  // now-live target and converges the backlog. reconcileMirror already passes ALL_SYNC_FACETS, so a
  // dropped unarchive signal still heals on the next reconcile.
  let effectiveFacets = facets;
  const preTarget = await targetCardFor(mirror, sourceCardId);
  if (preTarget?.archivedAt) {
    const [preSource] = await db.select().from(cards).where(and(eq(cards.id, sourceCardId), eq(cards.boardId, mirror.sourceBoardId))).limit(1);
    if (preSource && !preSource.archivedAt) {
      const marker = await findExternalLink({
        workspaceId: mirror.targetWorkspaceId,
        provider: providerFor(mirror),
        externalType: TARGET_MIRROR_ARCHIVE_LINK_TYPE,
        externalId: sourceCardId,
      });
      if (marker) effectiveFacets = ALL_SYNC_FACETS;
    }
  }
  const requested = new Set(effectiveFacets);
  for (const facet of CANONICAL_FACETS) if (requested.has(facet)) await convergeFacet(mirror, sourceCardId, facet);
}

export async function reconcileMirror(mirror: BoardMirror, gapStart: Date) {
  const providerLinks = await listExternalLinksByProvider(mirror.targetWorkspaceId, providerFor(mirror));
  const cardLinks = providerLinks.filter((link) => link.externalType === "card" && link.entityType === "card");
  for (const link of cardLinks) await convergeSourceCard(mirror, link.externalId, ALL_SYNC_FACETS);

  const mappings = await db.select({ sourceListId: boardMirrorLists.sourceListId }).from(boardMirrorLists).where(eq(boardMirrorLists.mirrorId, mirror.id));
  if (mappings.length === 0) return;
  const linkedIds = new Set(cardLinks.map((link) => link.externalId));
  // updatedAt is an intentional approximation: it catches cards moved into scope while outbox rows
  // were unavailable without turning a v1 reconcile into an unrestricted historical backfill.
  const candidates = await db.select({ id: cards.id }).from(cards).where(and(
    eq(cards.boardId, mirror.sourceBoardId),
    inArray(cards.listId, mappings.map((mapping) => mapping.sourceListId)),
    sql`(${cards.createdAt} >= ${mirror.createdAt} or ${cards.updatedAt} >= ${gapStart})`,
    linkedIds.size > 0 ? notInArray(cards.id, [...linkedIds]) : undefined,
  ));
  for (const candidate of candidates) await linkSourceCard(mirror, candidate.id);
}
