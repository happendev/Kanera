import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { clients } from "./client.js";

export const standaloneBoardGroups = pgTable(
  "standalone_board_group",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("standalone_board_groups_client_id_title_idx").on(t.clientId, t.title)],
);

export type StandaloneBoardGroup = typeof standaloneBoardGroups.$inferSelect;
export type NewStandaloneBoardGroup = typeof standaloneBoardGroups.$inferInsert;
