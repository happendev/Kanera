import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./workspace.js";

export const externalLinks = pgTable(
  "external_link",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    externalType: text("external_type").notNull(),
    externalId: text("external_id").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("external_links_workspace_provider_external_uq").on(t.workspaceId, t.provider, t.externalType, t.externalId),
    index("external_links_workspace_entity_idx").on(t.workspaceId, t.entityType, t.entityId),
    index("external_links_workspace_provider_idx").on(t.workspaceId, t.provider),
    // Card mirror status and reconciliation start from a source card id across mirror providers.
    // Keep that lookup narrow without making every other external-link provider pay for the index.
    index("external_links_mirror_card_source_idx")
      .on(t.externalId, t.provider, t.entityId)
      .where(sql`${t.provider} like 'mirror:%' and ${t.externalType} = 'card'`),
  ],
);

export type ExternalLink = typeof externalLinks.$inferSelect;
export type NewExternalLink = typeof externalLinks.$inferInsert;
