import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { valueIn } from "./_value-check.js";
import { clients } from "./client.js";
import { users } from "./user.js";
import { workspaces } from "./workspace.js";

export const CSV_IMPORT_STATUSES = ["analyzed", "ready", "importing", "completed", "failed"] as const;
export type CsvImportStatus = (typeof CSV_IMPORT_STATUSES)[number];

export const csvImports = pgTable(
  "csv_import",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
    createdById: uuid("created_by_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    status: text("status", { enum: CSV_IMPORT_STATUSES }).notNull().default("analyzed"),
    sourceFileKey: text("source_file_key").notNull(),
    sourceFileName: text("source_file_name").notNull(),
    manifest: jsonb("manifest").notNull(),
    source: jsonb("source").notNull(),
    columnMapping: jsonb("column_mapping"),
    mappings: jsonb("mappings"),
    result: jsonb("result"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("csv_imports_status_ck", valueIn(t.status, CSV_IMPORT_STATUSES)),
    index("csv_import_workspace_created_at_idx").on(t.workspaceId, t.createdAt),
  ],
);

export type CsvImport = typeof csvImports.$inferSelect;
