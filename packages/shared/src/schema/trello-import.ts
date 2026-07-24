import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { valueIn } from "./_value-check.js";
import { clients } from "./client.js";
import { users } from "./user.js";
import { workspaces } from "./workspace.js";

export const TRELLO_IMPORT_STATUSES = [
  "analyzed",
  "ready",
  "importing",
  "completed",
  "failed",
] as const;
export type TrelloImportStatus = (typeof TRELLO_IMPORT_STATUSES)[number];

export const trelloImports = pgTable(
  "trello_import",
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
    status: text("status", { enum: TRELLO_IMPORT_STATUSES }).notNull().default("ready"),
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
    check("trello_imports_status_ck", valueIn(t.status, TRELLO_IMPORT_STATUSES)),
    index("trello_import_workspace_created_at_idx").on(t.workspaceId, t.createdAt),
  ],
);

export type TrelloImport = typeof trelloImports.$inferSelect;
export type NewTrelloImport = typeof trelloImports.$inferInsert;
