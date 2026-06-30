import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { tsvector } from "./_tsvector.js";
import { cards } from "./card.js";
import { users } from "./user.js";
import { workspaceApiKeys } from "./workspace-api-key.js";

export const comments = pgTable(
  "comment",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    cardId: uuid("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    authorKind: text("author_kind").$type<"user" | "apiKey">().notNull().default("user"),
    apiKeyId: uuid("api_key_id")
      .references(() => workspaceApiKeys.id, { onDelete: "set null" }),
    apiKeyName: text("api_key_name"),
    body: text("body").notNull(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    // Full-text search vector over the comment body.
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(body, ''))`,
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("comments_card_id_created_at_idx").on(t.cardId, t.createdAt),
    index("comments_search_vector_idx").using("gin", t.searchVector),
  ],
);

export type Comment = typeof comments.$inferSelect;
export type NewComment = typeof comments.$inferInsert;
