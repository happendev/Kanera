import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { valueIn } from "./_value-check.js";
import { workspaces } from "./workspace.js";

export const INTERNAL_LINK_SOURCE_TYPES = ["card", "note"] as const;
export const INTERNAL_LINK_TARGET_TYPES = ["card", "board", "note"] as const;

export type InternalLinkSourceType = (typeof INTERNAL_LINK_SOURCE_TYPES)[number];
export type InternalLinkTargetType = (typeof INTERNAL_LINK_TARGET_TYPES)[number];

export const internalLinks = pgTable(
  "internal_link",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceType: text("source_type", { enum: INTERNAL_LINK_SOURCE_TYPES }).notNull(),
    sourceId: uuid("source_id").notNull(),
    targetType: text("target_type", { enum: INTERNAL_LINK_TARGET_TYPES }).notNull(),
    targetId: uuid("target_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("internal_links_source_type_ck", valueIn(t.sourceType, INTERNAL_LINK_SOURCE_TYPES)),
    check("internal_links_target_type_ck", valueIn(t.targetType, INTERNAL_LINK_TARGET_TYPES)),
    uniqueIndex("internal_links_source_target_uq").on(t.sourceType, t.sourceId, t.targetType, t.targetId),
    index("internal_links_workspace_target_idx").on(t.workspaceId, t.targetType, t.targetId),
    index("internal_links_workspace_source_idx").on(t.workspaceId, t.sourceType, t.sourceId),
  ],
);

export type InternalLink = typeof internalLinks.$inferSelect;
export type NewInternalLink = typeof internalLinks.$inferInsert;
