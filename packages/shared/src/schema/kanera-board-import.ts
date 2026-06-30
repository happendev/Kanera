import { sql } from "drizzle-orm";
import { index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { clients } from "./client.js";
import { users } from "./user.js";
import { workspaces } from "./workspace.js";

export const kaneraBoardImportStatus = pgEnum("kanera_board_import_status", [
  "ready",
  "importing",
  "completed",
  "failed",
]);
export type KaneraBoardImportStatus = (typeof kaneraBoardImportStatus.enumValues)[number];

export const kaneraBoardImports = pgTable(
  "kanera_board_import",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    createdById: uuid("created_by_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    status: kaneraBoardImportStatus("status").notNull().default("ready"),
    sourceFileKey: text("source_file_key").notNull(),
    sourceFileName: text("source_file_name").notNull(),
    manifest: jsonb("manifest").notNull(),
    source: jsonb("source").notNull(),
    mappings: jsonb("mappings"),
    result: jsonb("result"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("kanera_board_import_workspace_created_at_idx").on(t.workspaceId, t.createdAt),
  ],
);

export type KaneraBoardImport = typeof kaneraBoardImports.$inferSelect;
export type NewKaneraBoardImport = typeof kaneraBoardImports.$inferInsert;
