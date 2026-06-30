import { sql } from "drizzle-orm";
import { index, pgEnum, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./workspace.js";

export const internalLinkSourceType = pgEnum("internal_link_source_type", ["card", "note"]);
export const internalLinkTargetType = pgEnum("internal_link_target_type", ["card", "board", "note"]);

export type InternalLinkSourceType = (typeof internalLinkSourceType.enumValues)[number];
export type InternalLinkTargetType = (typeof internalLinkTargetType.enumValues)[number];

export const internalLinks = pgTable(
  "internal_link",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceType: internalLinkSourceType("source_type").notNull(),
    sourceId: uuid("source_id").notNull(),
    targetType: internalLinkTargetType("target_type").notNull(),
    targetId: uuid("target_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("internal_links_source_target_uq").on(t.sourceType, t.sourceId, t.targetType, t.targetId),
    index("internal_links_workspace_target_idx").on(t.workspaceId, t.targetType, t.targetId),
    index("internal_links_workspace_source_idx").on(t.workspaceId, t.sourceType, t.sourceId),
  ],
);

export type InternalLink = typeof internalLinks.$inferSelect;
export type NewInternalLink = typeof internalLinks.$inferInsert;
