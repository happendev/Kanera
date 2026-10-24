import type { DependencyGraphBody, DependencyGraphCard, DependencyGraphEdge, DependencyGraphResponse } from "@kanera/shared/dto";
import { compactCardSummary } from "@kanera/shared/events";
import { boards, cardLabels, cardRelations, cards, customFields, lists, users } from "@kanera/shared/schema";
import { and, asc, eq, exists, inArray, isNull, or } from "drizzle-orm";
import type { AuthClaims } from "../auth/plugin.js";
import { db } from "../db.js";
import { assertBoardAccess } from "./access.js";
import { loadWorkCardSummaries, toWireCardSummary } from "./card-summary.js";
import { attachFieldOptions } from "./custom-fields.js";
import { readableCardIds } from "./internal-links.js";
import { signedAvatarUrl } from "./media-keys.js";
import { absoluteCardUrl } from "./wire-card.js";
import { assertBoardFeature, featureDisabledError, loadWorkspaceFeaturesMap } from "./workspace-features.js";

/**
 * The most cards one map holds. A map is read by a person, and past a few hundred tiles the
 * chains stop being legible long before the query gets expensive; the response says it stopped.
 */
const DEPENDENCY_GRAPH_MAX_CARDS = 400;

type CardRef = { id: string; boardId: string; workspaceId: string; completedAt: Date | null; archivedAt: Date | null };

const cardRef = { id: cards.id, boardId: cards.boardId, workspaceId: cards.workspaceId, completedAt: cards.completedAt, archivedAt: cards.archivedAt };

/** Whether a card has at least one relation, in either direction and of either kind. */
const hasRelation = exists(
  db.select({ one: cardRelations.id }).from(cardRelations)
    .where(or(eq(cardRelations.sourceCardId, cards.id), eq(cardRelations.targetCardId, cards.id))),
);

/**
 * Builds the dependency map for one scope, as this viewer may see it.
 *
 * Seeds are the scope's open, unarchived cards that have any relation. From there the walk follows
 * `blocks` edges in both directions, one ring at a time, through cards the viewer can open. It stops
 * at completed cards (they appear, so a chain shows what has already been cleared, but their own
 * history is not walked) and never steps through a card the viewer cannot open: that card is left
 * off the map entirely, as card detail leaves it off the relations list, and the cards it blocks
 * still say they are blocked through `blockedByCount`. `relates_to` neighbours are added one hop
 * from the seeds only; a "related" web would otherwise swallow the workspace.
 *
 * Relations never cross workspaces, so the walk stays inside the seeds' workspace(s) by construction.
 */
export async function loadDependencyGraph(claims: AuthClaims, scope: DependencyGraphBody): Promise<DependencyGraphResponse> {
  const seeds = await seedCards(claims, scope);
  const onMap = new Map<string, CardRef>();
  const inScope = new Set<string>();
  for (const seed of seeds.slice(0, DEPENDENCY_GRAPH_MAX_CARDS)) {
    onMap.set(seed.id, seed);
    inScope.add(seed.id);
  }
  let truncated = seeds.length > DEPENDENCY_GRAPH_MAX_CARDS;

  let frontier = [...onMap.keys()];
  let firstRing = true;
  while (frontier.length && !truncated) {
    const rows = await db
      .select({ kind: cardRelations.kind, other: cardRef })
      .from(cardRelations)
      .innerJoin(cards, or(
        and(inArray(cardRelations.sourceCardId, frontier), eq(cards.id, cardRelations.targetCardId)),
        and(inArray(cardRelations.targetCardId, frontier), eq(cards.id, cardRelations.sourceCardId)),
      ))
      .where(and(
        or(inArray(cardRelations.sourceCardId, frontier), inArray(cardRelations.targetCardId, frontier)),
        isNull(cards.archivedAt),
      ));
    const candidates = new Map<string, CardRef>();
    for (const row of rows) {
      // A relation between two frontier cards joins each as the other's "other"; both are on the map.
      if (onMap.has(row.other.id) || candidates.has(row.other.id)) continue;
      if (row.kind === "relates_to" && !firstRing) continue;
      candidates.set(row.other.id, row.other);
    }
    const readable = await readableCardIds(claims, [...candidates.values()]);
    const walkOn = new Set(rows.filter((row) => row.kind === "blocks").map((row) => row.other.id));
    const next: string[] = [];
    for (const candidate of candidates.values()) {
      if (!readable.has(candidate.id)) continue;
      if (onMap.size >= DEPENDENCY_GRAPH_MAX_CARDS) {
        truncated = true;
        break;
      }
      onMap.set(candidate.id, candidate);
      if (walkOn.has(candidate.id) && !candidate.completedAt) next.push(candidate.id);
    }
    frontier = next;
    firstRing = false;
  }

  const ids = [...onMap.keys()];
  if (ids.length === 0) return { cards: [], edges: [], boards: [], lists: [], labels: [], people: [], customFields: [], truncated: false };
  const [edgeRows, summaries] = await Promise.all([
    db.select({ id: cardRelations.id, sourceCardId: cardRelations.sourceCardId, targetCardId: cardRelations.targetCardId, kind: cardRelations.kind })
      .from(cardRelations)
      .where(and(inArray(cardRelations.sourceCardId, ids), inArray(cardRelations.targetCardId, ids))),
    loadWorkCardSummaries(ids),
  ]);
  // Tiles show what a board card shows: only `showOnCard` fields, which also keeps the payload to
  // the values a tile renders rather than every field a work summary carries.
  const shownFields = await cardFaceFields([...new Set(summaries.map((row) => row.workspaceId))]);
  const shownFieldIds = new Set(shownFields.map((field) => field.id));
  const graphCards: DependencyGraphCard[] = summaries.map((row) => {
    const summary = toWireCardSummary(row, claims.cid, shownFieldIds);
    return { ...compactCardSummary(summary), inScope: inScope.has(row.id), url: absoluteCardUrl(summary.organisationKey, summary.key) };
  });
  // Stable order so the client's layout does not reshuffle between identical re-reads.
  const edges: DependencyGraphEdge[] = edgeRows.sort((a, b) => a.id.localeCompare(b.id));
  return { cards: graphCards, edges, ...await graphLookups(claims, graphCards), customFields: shownFields, truncated };
}

/** The scope's open cards with any relation that the viewer can open, oldest first. */
async function seedCards(claims: AuthClaims, scope: DependencyGraphBody): Promise<CardRef[]> {
  const open = and(isNull(cards.completedAt), isNull(cards.archivedAt), hasRelation);
  let rows: CardRef[];
  if ("boardId" in scope) {
    // A board the viewer cannot open is refused like every other board read, not an empty map.
    await assertBoardAccess(claims, scope.boardId);
    await assertBoardFeature(scope.boardId, "dependencies");
    rows = await db.select(cardRef).from(cards).where(and(eq(cards.boardId, scope.boardId), open)).orderBy(cards.createdAt, cards.id);
  } else if ("workspaceId" in scope) {
    // No workspace check of its own: board guests read workspace boards without being workspace
    // members, and every card below is filtered per board. An unknown or foreign workspace simply
    // yields no readable cards, which says nothing about whether it exists.
    rows = await db.select(cardRef).from(cards).where(and(eq(cards.workspaceId, scope.workspaceId), open)).orderBy(cards.createdAt, cards.id);
  } else {
    rows = await db.select(cardRef).from(cards).where(and(inArray(cards.id, [...new Set(scope.cardIds)]), open)).orderBy(cards.createdAt, cards.id);
  }
  const readable = await readableCardIds(claims, rows);
  const visible = rows.filter((row) => readable.has(row.id));
  // A workspace with dependencies switched off has no map. A workspace scope is refused only once
  // the viewer has shown it can read cards there; an explicit card set (Global Work, which can span
  // workspaces) simply leaves those workspaces' cards out.
  const features = await loadWorkspaceFeaturesMap(visible.map((row) => row.workspaceId));
  if ("workspaceId" in scope && features.get(scope.workspaceId)?.dependencies === false) throw featureDisabledError("dependencies");
  return visible.filter((row) => features.get(row.workspaceId)?.dependencies !== false);
}

/** Active card-face fields of the given workspaces, with their options, in workspace order. */
async function cardFaceFields(workspaceIds: string[]) {
  if (workspaceIds.length === 0) return [];
  const rows = await db.select().from(customFields)
    .where(and(inArray(customFields.workspaceId, workspaceIds), eq(customFields.showOnCard, true), isNull(customFields.archivedAt)))
    .orderBy(asc(customFields.position), asc(customFields.id));
  return attachFieldOptions(rows);
}

async function graphLookups(claims: AuthClaims, graphCards: readonly DependencyGraphCard[]): Promise<Pick<DependencyGraphResponse, "boards" | "lists" | "labels" | "people">> {
  const boardIds = [...new Set(graphCards.map((card) => card.boardId))];
  const listIds = [...new Set(graphCards.map((card) => card.listId))];
  const labelIds = [...new Set(graphCards.flatMap((card) => card.labelIds ?? []))];
  const userIds = [...new Set(graphCards.flatMap((card) => card.assigneeIds ?? []))];
  const [boardRows, editable, listRows, labelRows, userRows] = await Promise.all([
    db.select({ id: boards.id, name: boards.name, icon: boards.icon, iconColor: boards.iconColor }).from(boards).where(inArray(boards.id, boardIds)),
    // The same check the relation routes make on the dependent card, so the map only offers to add
    // or remove a dependency where the write will be accepted. A read-only credential edits nothing.
    Promise.all(boardIds.map((id) => assertBoardAccess(claims, id, "editor").then(() => id, () => null)))
      .then((ids) => new Set(ids.filter((id) => id !== null))),
    db.select({ id: lists.id, name: lists.name }).from(lists).where(inArray(lists.id, listIds)),
    labelIds.length
      ? db.select({ id: cardLabels.id, name: cardLabels.name, color: cardLabels.color }).from(cardLabels).where(inArray(cardLabels.id, labelIds))
      : [],
    userIds.length
      ? db.select({ userId: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl, clientId: users.clientId }).from(users).where(inArray(users.id, userIds))
      : [],
  ]);
  return {
    boards: boardRows.map((board) => ({ ...board, canEdit: editable.has(board.id) })),
    lists: listRows,
    labels: labelRows,
    // Only assignees of cards the viewer can open get here, so naming them leaks nothing the cards don't.
    people: userRows.map(({ clientId, avatarUrl, ...user }) => ({ ...user, avatarUrl: signedAvatarUrl(clientId, avatarUrl) })),
  };
}
