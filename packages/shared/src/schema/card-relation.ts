import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { valueIn } from "./_value-check.js";
import { cards } from "./card.js";
import { users } from "./user.js";
import { workspaces } from "./workspace.js";
import { CARD_RELATION_KINDS, type CardRelationKind } from "../lib/card-relations.js";

export { CARD_RELATION_KINDS, type CardRelationKind };

/**
 * Explicit, typed card-to-card relations ("A blocks B", "A relates to B").
 *
 * Deliberately not stored in `internal_link`: that table is derived from description markdown and
 * `replaceInternalLinksForSource` wipes and rebuilds a card's rows on every description save and
 * detail open, which would silently delete relations a user chose.
 *
 * Both cards are always in the same workspace (lists and fields are workspace-scoped, so a relation
 * never needs to span tenancy). `blocks` is directional and kept acyclic by the API; `relates_to` is
 * symmetric and stored once, with the lexically smaller card id as the source.
 */
export const cardRelations = pgTable(
  "card_relation",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceCardId: uuid("source_card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    targetCardId: uuid("target_card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: CARD_RELATION_KINDS }).notNull(),
    createdById: uuid("created_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("card_relations_kind_ck", valueIn(t.kind, CARD_RELATION_KINDS)),
    check("card_relations_not_self_ck", sql`${t.sourceCardId} <> ${t.targetCardId}`),
    uniqueIndex("card_relations_source_target_kind_uq").on(t.sourceCardId, t.targetCardId, t.kind),
    index("card_relations_target_idx").on(t.targetCardId, t.kind),
    // Nothing reads relations by workspace, but deleting a workspace cascades here by this column;
    // without it each delete scans every tenant's relations.
    index("card_relations_workspace_id_idx").on(t.workspaceId),
  ],
);

export type CardRelation = typeof cardRelations.$inferSelect;
