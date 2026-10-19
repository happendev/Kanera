import { z } from "zod";
import type { CompactCardSummary, WireCustomField } from "../events/index.js";
import { CARD_RELATION_DIRECTIONS, type CardRelationDirection, type CardRelationKind } from "../lib/card-relations.js";
import type { ColorToken } from "../lib/colors.js";

export const cardRelationDirection = z.enum(CARD_RELATION_DIRECTIONS);

/**
 * POST /cards/:id/relations. `direction` is read from the path card's point of view: `blocks`
 * means "this card blocks `targetCardId`", `blocked_by` means "`targetCardId` blocks this card".
 */
export const addCardRelationBody = z.object({
  targetCardId: z.uuid(),
  direction: cardRelationDirection,
});
export type AddCardRelationBody = z.infer<typeof addCardRelationBody>;

/** The other card of a relation, as the viewer may see it. */
export type CardRelationCard = {
  id: string;
  organisationKey: string;
  key: string;
  title: string;
  boardId: string;
  boardName: string;
  listName: string;
  completedAt: string | null;
  archivedAt: string | null;
  /** Active labels in assignment order, as on the card's tile. */
  labels: { id: string; name: string; color: ColorToken | null }[];
  /** Assignees in assignment order, as on the card's tile. */
  assignees: { userId: string; displayName: string; avatarUrl: string | null }[];
};

export type CardRelationSummary = {
  id: string;
  direction: CardRelationDirection;
  card: CardRelationCard;
  createdAt: string;
};

/**
 * GET /cards/:id/relations, and the `relations` / `hiddenBlockerCount` pair on card detail.
 * Relations to cards the viewer cannot open are left out; open blockers among them are only
 * counted, so a viewer learns the card is blocked without learning by what.
 */
export interface CardRelationsResponse {
  relations: CardRelationSummary[];
  hiddenBlockerCount: number;
}

/** Web preflight only: completion remains available to API clients without an interactive prompt. */
export const completionWarningBody = z.union([
  z.object({ cardIds: z.array(z.uuid()).min(1).max(500) }),
  z.object({ boardId: z.uuid(), listId: z.uuid() }),
]);
export type CompletionWarningBody = z.infer<typeof completionWarningBody>;
export interface CompletionWarningResponse { blockedCardCount: number }

/**
 * POST /cards/dependency-graph (also /api/v1 for API clients and agents): the dependency map behind
 * the Dependencies view. Exactly one scope:
 * a board, a whole workspace, or an explicit set of cards (the cards a Global Work lens has loaded).
 *
 * The server seeds the map with the scope's open cards that have any relation and follows `blocks`
 * edges outward from them, across boards, through open cards the viewer can read. Completed cards
 * appear where a chain reaches them but are not walked through, so a map shows live work and the
 * blockers it has already cleared, not the workspace's whole dependency history.
 */
export const dependencyGraphBody = z.union([
  z.object({ boardId: z.uuid() }).strict(),
  z.object({ workspaceId: z.uuid() }).strict(),
  z.object({ cardIds: z.array(z.uuid()).min(1).max(2000) }).strict(),
]);
export type DependencyGraphBody = z.infer<typeof dependencyGraphBody>;

/**
 * A card on the map. `inScope` marks cards the request asked about (on the board, in the loaded
 * set); the rest were pulled in because a chain crosses into them. `blockedByCount` keeps counting
 * blockers the viewer cannot open, so the client can say how many blockers are off the map. `url`
 * is the canonical browser link, for API clients and agents that cannot build card paths.
 */
export type DependencyGraphCard = CompactCardSummary & { inScope: boolean; url: string };

export type DependencyGraphEdge = {
  id: string;
  /** For `blocks`, the blocker. `relates_to` is symmetric and stored with the smaller id here. */
  sourceCardId: string;
  targetCardId: string;
  kind: CardRelationKind;
};

export interface DependencyGraphResponse {
  cards: DependencyGraphCard[];
  /** Only edges whose two cards are both on the map. */
  edges: DependencyGraphEdge[];
  /**
   * Lookups for the cards on the map, which may sit on boards the host page has not loaded.
   * `canEdit`: the viewer may add and remove dependencies of this board's cards (editor access).
   */
  boards: { id: string; name: string; icon: string | null; iconColor: ColorToken | null; canEdit: boolean }[];
  lists: { id: string; name: string }[];
  labels: { id: string; name: string; color: ColorToken | null }[];
  people: { userId: string; displayName: string; avatarUrl: string | null }[];
  /**
   * The active custom fields shown on card faces (`showOnCard`) in the map's workspaces. Each
   * card's `customFieldValues` carries only these fields' values, as the board-open payload does.
   */
  customFields: WireCustomField[];
  /** The walk stopped at the card cap; the map is a partial view of the chains it reached. */
  truncated: boolean;
}
