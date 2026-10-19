/**
 * Card relation kinds. Dependency-free like `due-date-slots.ts`: the schema CHECK, the Zod DTOs, the
 * web bundle and the MCP tool schema all share this tuple.
 *
 * `blocks` reads source → target ("source blocks target", so the target is *blocked by* the
 * source). `relates_to` is symmetric.
 */
export const CARD_RELATION_KINDS = ["blocks", "relates_to"] as const;
export type CardRelationKind = (typeof CARD_RELATION_KINDS)[number];

/**
 * The direction a relation is described from one card's point of view. A stored `blocks` row is
 * `blocks` on its source and `blocked_by` on its target.
 */
export const CARD_RELATION_DIRECTIONS = ["blocks", "blocked_by", "relates_to"] as const;
export type CardRelationDirection = (typeof CARD_RELATION_DIRECTIONS)[number];
