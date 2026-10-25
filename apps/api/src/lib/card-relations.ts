import type { CardRelationsResponse, CardRelationSummary } from "@kanera/shared/dto";
import type { CardRelationDirection } from "@kanera/shared/card-relations";
import { compactWireCard, SERVER_EVENTS } from "@kanera/shared/events";
import { boards, cardAssignees, cardLabelAssignments, cardLabels, cardRelations, cards, clients, eventOutbox, lists, users, workspaces, type CardRelationKind } from "@kanera/shared/schema";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { AuthClaims } from "../auth/plugin.js";
import { db, type Tx, type TxOnly } from "../db.js";
import { currentOutboxActor } from "../realtime/outbox.js";
import { emitToBoard } from "../realtime/emit.js";
import { badRequest } from "./errors.js";
import { emitInternalLinksChanged, readableCardIds } from "./internal-links.js";
import { signedAvatarUrl } from "./media-keys.js";
import { toWireCard } from "./wire-card.js";
import { featureEnabledSql, loadWorkspaceFeatures, loadWorkspaceFeaturesMap } from "./workspace-features.js";

/**
 * How a stored row is stored for a relation described from `cardId`'s side. `relates_to` is
 * symmetric, so it is stored once with the smaller id as the source and the unique index dedups
 * "A relates to B" against "B relates to A".
 */
export function storedRelation(cardId: string, otherCardId: string, direction: CardRelationDirection): {
  sourceCardId: string;
  targetCardId: string;
  kind: CardRelationKind;
} {
  if (direction === "blocks") return { sourceCardId: cardId, targetCardId: otherCardId, kind: "blocks" };
  if (direction === "blocked_by") return { sourceCardId: otherCardId, targetCardId: cardId, kind: "blocks" };
  const [sourceCardId, targetCardId] = cardId < otherCardId ? [cardId, otherCardId] : [otherCardId, cardId];
  return { sourceCardId, targetCardId, kind: "relates_to" };
}

/** The direction a stored row reads in from `cardId`'s side. */
export function relationDirectionFor(
  cardId: string,
  row: { sourceCardId: string; kind: CardRelationKind },
): CardRelationDirection {
  if (row.kind === "relates_to") return "relates_to";
  return row.sourceCardId === cardId ? "blocks" : "blocked_by";
}

/**
 * Serialises relation writes per workspace so two concurrent "A blocks B" / "B blocks A" requests
 * cannot both pass the cycle check. Relations never cross workspaces, so this is the whole graph.
 */
export async function lockWorkspaceRelations(tx: TxOnly, workspaceId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`card_relation:${workspaceId}`}))`);
}

/**
 * Rejects `blockerId blocks blockedId` when `blockedId` already (transitively) blocks `blockerId`.
 * Walks forward from the would-be blocked card along existing `blocks` edges; reaching the blocker
 * means the new edge would close a loop, and a loop of blockers can never be cleared.
 */
export async function assertNoBlockingCycle(tx: Tx, blockerId: string, blockedId: string): Promise<void> {
  const result = await tx.execute<{ found: boolean }>(sql`
    with recursive downstream(card_id) as (
      select ${blockedId}::uuid
      union
      select cr.target_card_id
      from card_relation cr
      inner join downstream d on d.card_id = cr.source_card_id
      where cr.kind = 'blocks'
    )
    select exists (select 1 from downstream where card_id = ${blockerId}::uuid) as found
  `);
  if (result.rows[0]?.found) throw badRequest("this relation would create a blocking cycle");
}

/**
 * Open blockers per card. "Open" means neither completed nor archived, matching the
 * `blocked_by_count` column of `card_summary_view` and the board-open summary CTE. Hidden blockers
 * count: the number is viewer-independent so it can ride board-room events.
 */
export async function blockedByCounts(database: Tx, cardIds: readonly string[]): Promise<Map<string, number>> {
  const unique = [...new Set(cardIds)];
  if (unique.length === 0) return new Map();
  const blockers = alias(cards, "blocker");
  const rows = await database
    .select({ cardId: cardRelations.targetCardId, count: sql<number>`count(*)::integer` })
    .from(cardRelations)
    .innerJoin(blockers, eq(blockers.id, cardRelations.sourceCardId))
    // A workspace with dependencies switched off has no blocked cards, whatever rows it keeps.
    .innerJoin(workspaces, eq(workspaces.id, cardRelations.workspaceId))
    .innerJoin(clients, eq(clients.id, workspaces.clientId))
    .where(and(
      inArray(cardRelations.targetCardId, unique),
      eq(cardRelations.kind, "blocks"),
      featureEnabledSql("dependencies"),
      isNull(blockers.completedAt),
      isNull(blockers.archivedAt),
    ))
    .groupBy(cardRelations.targetCardId);
  return new Map(rows.map((row) => [row.cardId, row.count]));
}

/**
 * A card's relations as one viewer may see them. Relations to cards the viewer cannot open are
 * dropped; the open blockers among them are only counted, so a card on a private board can still
 * say "blocked by 1 card you can't access" without leaking its title, board or list.
 */
export async function loadCardRelations(claims: AuthClaims, cardId: string): Promise<CardRelationsResponse> {
  const other = alias(cards, "other_card");
  const allRows = await db
    .select({
      id: cardRelations.id,
      workspaceId: cardRelations.workspaceId,
      sourceCardId: cardRelations.sourceCardId,
      kind: cardRelations.kind,
      createdAt: cardRelations.createdAt,
      otherId: other.id,
      otherBoardId: other.boardId,
      organisationKey: other.organisationKey,
      key: other.key,
      title: other.title,
      completedAt: other.completedAt,
      archivedAt: other.archivedAt,
      boardName: boards.name,
      listName: lists.name,
    })
    .from(cardRelations)
    .innerJoin(other, or(
      and(eq(cardRelations.sourceCardId, cardId), eq(other.id, cardRelations.targetCardId)),
      and(eq(cardRelations.targetCardId, cardId), eq(other.id, cardRelations.sourceCardId)),
    ))
    .innerJoin(boards, eq(boards.id, other.boardId))
    .innerJoin(lists, eq(lists.id, other.listId))
    .where(or(eq(cardRelations.sourceCardId, cardId), eq(cardRelations.targetCardId, cardId)));
  // Dependencies switched off hide `blocks` rows (kept for re-enabling); `relates_to` stays.
  const blocksRow = allRows.find((row) => row.kind === "blocks");
  const rows = blocksRow && !(await loadWorkspaceFeatures(blocksRow.workspaceId)).dependencies
    ? allRows.filter((row) => row.kind !== "blocks")
    : allRows;

  const readable = await readableCardIds(claims, rows.map((row) => ({ id: row.otherId, boardId: row.otherBoardId })));
  const readableIds = rows.map((row) => row.otherId).filter((id) => readable.has(id));
  const [labelsByCard, assigneesByCard] = await Promise.all([relationCardLabels(readableIds), relationCardAssignees(readableIds)]);
  const relations: CardRelationSummary[] = [];
  let hiddenBlockerCount = 0;
  for (const row of rows) {
    const direction = relationDirectionFor(cardId, row);
    if (!readable.has(row.otherId)) {
      if (direction === "blocked_by" && !row.completedAt && !row.archivedAt) hiddenBlockerCount += 1;
      continue;
    }
    relations.push({
      id: row.id,
      direction,
      createdAt: row.createdAt.toISOString(),
      card: {
        id: row.otherId,
        organisationKey: row.organisationKey,
        key: row.key,
        title: row.title,
        boardId: row.otherBoardId,
        boardName: row.boardName,
        listName: row.listName,
        completedAt: row.completedAt?.toISOString() ?? null,
        archivedAt: row.archivedAt?.toISOString() ?? null,
        labels: labelsByCard.get(row.otherId) ?? [],
        assignees: assigneesByCard.get(row.otherId) ?? [],
      },
    });
  }
  // Stable for the UI: grouped by direction there, oldest relation first within a group.
  relations.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return { relations, hiddenBlockerCount };
}

/** Active labels of the readable related cards, in assignment order like the tile's label bar. */
export async function relationCardLabels(cardIds: readonly string[]): Promise<Map<string, CardRelationSummary["card"]["labels"]>> {
  const byCard = new Map<string, CardRelationSummary["card"]["labels"]>();
  if (cardIds.length === 0) return byCard;
  const rows = await db
    .select({ cardId: cardLabelAssignments.cardId, id: cardLabels.id, name: cardLabels.name, color: cardLabels.color })
    .from(cardLabelAssignments)
    .innerJoin(cardLabels, eq(cardLabels.id, cardLabelAssignments.labelId))
    .where(and(inArray(cardLabelAssignments.cardId, [...new Set(cardIds)]), isNull(cardLabels.archivedAt)))
    .orderBy(cardLabelAssignments.assignedAt, cardLabelAssignments.labelId);
  for (const { cardId, ...label } of rows) {
    const list = byCard.get(cardId);
    if (list) list.push(label);
    else byCard.set(cardId, [label]);
  }
  return byCard;
}

/**
 * Assignees of the readable related cards, in assignment order like the tile's avatar stack. Only
 * cards the viewer can open get here, so naming who owns them leaks nothing the card itself wouldn't.
 */
export async function relationCardAssignees(cardIds: readonly string[]): Promise<Map<string, CardRelationSummary["card"]["assignees"]>> {
  const byCard = new Map<string, CardRelationSummary["card"]["assignees"]>();
  if (cardIds.length === 0) return byCard;
  const rows = await db
    .select({ cardId: cardAssignees.cardId, userId: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl, userClientId: users.clientId })
    .from(cardAssignees)
    .innerJoin(users, eq(users.id, cardAssignees.userId))
    .where(inArray(cardAssignees.cardId, [...new Set(cardIds)]))
    .orderBy(cardAssignees.assignedAt, cardAssignees.userId);
  for (const { cardId, userClientId, avatarUrl, ...user } of rows) {
    const assignee = { ...user, avatarUrl: signedAvatarUrl(userClientId, avatarUrl) };
    const list = byCard.get(cardId);
    if (list) list.push(assignee);
    else byCard.set(cardId, [assignee]);
  }
  return byCard;
}

/**
 * Re-announces each card with its current open-blocker count, on its own board. Used after a
 * relation is added or removed and after a blocker opens or closes; the card row itself did not
 * change, so this is the only way tiles on that board learn the badge flipped. Run after commit.
 */
export async function emitBlockedByCountChanged(cardIds: readonly string[], clientId: string): Promise<void> {
  const unique = [...new Set(cardIds)];
  if (unique.length === 0) return;
  const [allRows, counts] = await Promise.all([
    db.select().from(cards).where(inArray(cards.id, unique)),
    blockedByCounts(db, unique),
  ]);
  // Nothing to re-announce where dependencies are switched off: those tiles show no blockers.
  const features = await loadWorkspaceFeaturesMap(allRows.map((card) => card.workspaceId));
  const rows = allRows.filter((card) => features.get(card.workspaceId)?.dependencies !== false);
  await emitInternalLinksChanged({ cardIds: unique, noteIds: [] });
  await Promise.all(rows.map((card) => emitToBoard(card.boardId, SERVER_EVENTS.CARD_UPDATED, {
    boardId: card.boardId,
    card: toWireCard(card, clientId),
    blockedByCount: counts.get(card.id) ?? 0,
  })));
}

/**
 * Capture active edges before changing their blockers, under the same lock as relation edits.
 * Taking this lock BEFORE card writes avoids opposite lock ordering and makes concurrent final
 * blocker completions observe one blocked-to-ready transition. Snapshot metadata survives deletes.
 */
export async function captureBlockedDependents(tx: TxOnly, workspaceId: string, blockerIds: readonly string[]) {
  await lockWorkspaceRelations(tx, workspaceId);
  if (!blockerIds.length) return [];
  // With dependencies switched off nothing is blocked, so completing a blocker hands nothing off:
  // no blockers-cleared activity, notifications, card_unblocked automations or MCP events.
  if (!(await loadWorkspaceFeatures(workspaceId, tx)).dependencies) return [];
  const blocker = alias(cards, "blocker");
  const dependent = alias(cards, "dependent");
  // Hosted plan archival retains card rows, but those boards cannot receive actionable handoffs.
  const dependentBoard = alias(boards, "dependent_board");
  return tx.select({ dependentId: dependent.id, blocker: { id: blocker.id, key: blocker.key, title: blocker.title, boardId: blocker.boardId } })
    .from(cardRelations)
    .innerJoin(blocker, eq(blocker.id, cardRelations.sourceCardId))
    .innerJoin(dependent, eq(dependent.id, cardRelations.targetCardId))
    .innerJoin(dependentBoard, eq(dependentBoard.id, dependent.boardId))
    .where(and(inArray(blocker.id, [...blockerIds]), eq(cardRelations.kind, "blocks"),
      isNull(blocker.completedAt), isNull(blocker.archivedAt), isNull(dependent.completedAt), isNull(dependent.archivedAt), isNull(dependentBoard.archivedAt)));
}

export type BlockedDependentsSnapshot = Awaited<ReturnType<typeof captureBlockedDependents>>;

/** Only candidates that had an active blocker before the mutation can become newly ready. */
export async function clearedDependents(tx: Tx, before: BlockedDependentsSnapshot) {
  const counts = await blockedByCounts(tx, before.map((row) => row.dependentId));
  const seen = new Set<string>();
  return before.filter((row) => {
    if (seen.has(row.dependentId) || (counts.get(row.dependentId) ?? 0) > 0) return false;
    seen.add(row.dependentId);
    return true;
  });
}

/** Snapshot ready dependents under the graph lock before reopening/restoring a blocker. */
export async function captureUnblockedDependents(tx: TxOnly, workspaceId: string, blockerIds: readonly string[]): Promise<string[]> {
  await lockWorkspaceRelations(tx, workspaceId);
  // Reopening a blocker cannot re-block anything while dependencies are switched off.
  if (!(await loadWorkspaceFeatures(workspaceId, tx)).dependencies) return [];
  const ids = await dependentCardIds(tx, blockerIds);
  const counts = await blockedByCounts(tx, ids);
  return ids.filter((id) => !counts.has(id));
}

/**
 * Persist the boundary with the mutation, even when no automation is configured. MCP subscribers
 * need the occurrence's list and actor, not a later count refresh that may already have changed.
 * The row is for integrations only (webhooks, MCP events): it is written before the automations
 * the boundary triggers, so by the time the outbox drains, this snapshot of the card can be stale
 * (an automation may already have moved or completed it). Browsers get the current row from the
 * post-commit `card:updated` emits instead, so this row is marked as already dispatched to them.
 */
export async function recordDependencyTransition(
  tx: Tx,
  card: typeof cards.$inferSelect,
  clientId: string,
  dependencyTransition: "blocked" | "unblocked",
  blockedByCount: number,
): Promise<void> {
  await tx.insert(eventOutbox).values({
    scope: "board", scopeId: card.boardId, boardId: card.boardId, workspaceId: card.workspaceId,
    eventType: SERVER_EVENTS.CARD_UPDATED,
    payload: { boardId: card.boardId, card: compactWireCard(toWireCard(card, clientId)), blockedByCount, dependencyTransition },
    actor: currentOutboxActor(),
    realtimeDispatched: true,
  });
}

/**
 * Cards related to any of `cardIds`, in either direction and of either kind. A member of `cardIds`
 * is included only when it is related to another member: a bulk edit of two related cards changes
 * what each shows about the other, and the cards' own events never refresh that section. Read
 * inside the transaction before a delete: the cascade removes the rows (a deleted member in the
 * result is harmless, since the invalidation only reaches cards that still exist).
 */
export async function relationNeighbourIds(database: Tx, cardIds: readonly string[]): Promise<string[]> {
  const unique = [...new Set(cardIds)];
  if (unique.length === 0) return [];
  const own = new Set(unique);
  const rows = await database
    .select({ sourceCardId: cardRelations.sourceCardId, targetCardId: cardRelations.targetCardId })
    .from(cardRelations)
    .where(or(inArray(cardRelations.sourceCardId, unique), inArray(cardRelations.targetCardId, unique)));
  const neighbours = new Set<string>();
  for (const row of rows) {
    if (own.has(row.sourceCardId) && own.has(row.targetCardId)) {
      neighbours.add(row.sourceCardId);
      neighbours.add(row.targetCardId);
    } else {
      neighbours.add(own.has(row.sourceCardId) ? row.targetCardId : row.sourceCardId);
    }
  }
  return [...neighbours];
}

/**
 * A related card's Dependencies section denormalises this card's title, labels, assignees, location
 * and lifecycle, and those cards may sit on boards whose rooms never hear this card's own events.
 * So any such change tells each neighbour to re-read its relations (invalidation only, like
 * `emitInternalLinksChanged`). Run after commit; a delete must capture the neighbours first.
 */
export async function emitRelationNeighboursChanged(cardIds: readonly string[], neighbourIds?: readonly string[]): Promise<void> {
  const neighbours = neighbourIds ?? await relationNeighbourIds(db, cardIds);
  if (neighbours.length === 0) return;
  await emitInternalLinksChanged({ cardIds: [...neighbours], noteIds: [] });
}


/** Cards that `blockerIds` block. Read before a delete, whose cascade removes the rows. */
async function dependentCardIds(database: Tx, blockerIds: readonly string[]): Promise<string[]> {
  const unique = [...new Set(blockerIds)];
  if (unique.length === 0) return [];
  const rows = await database
    .selectDistinct({ id: cardRelations.targetCardId })
    .from(cardRelations)
    .where(and(inArray(cardRelations.sourceCardId, unique), eq(cardRelations.kind, "blocks")));
  return rows.map((row) => row.id);
}

/**
 * The single hook for "a card's open/closed state changed": completion, reopening, archive,
 * unarchive and delete, whether by a person, an automation or mirror convergence. Dependents may
 * sit on other boards in the workspace, so each is announced on its own board, not the blocker's.
 * Every other related card (the cards this one is blocked by, and `relates_to` neighbours) shows
 * this card's status in its Dependencies section, so they re-read too.
 * Pass `dependentIds` when the relation rows are already gone (card delete).
 */
export async function emitDependentsChanged(
  blockerIds: readonly string[],
  clientId: string,
  dependentIds?: readonly string[],
): Promise<void> {
  if (blockerIds.length === 0 && !dependentIds?.length) return;
  const dependents = dependentIds ?? await dependentCardIds(db, blockerIds);
  await emitBlockedByCountChanged(dependents, clientId);
  const announced = new Set(dependents);
  await emitRelationNeighboursChanged(blockerIds, (await relationNeighbourIds(db, blockerIds)).filter((id) => !announced.has(id)));
}
