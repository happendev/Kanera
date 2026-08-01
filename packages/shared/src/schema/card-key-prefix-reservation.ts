import { sql } from "drizzle-orm";
import { check, index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Permanent prefix ownership inside one organisation. Deliberately no client/workspace foreign
 * keys: aliases and tombstones must survive deletion so an old reference can never be retargeted.
 */
export const cardKeyPrefixReservations = pgTable(
  "card_key_prefix_reservation",
  {
    clientId: uuid("client_id").notNull(),
    prefix: text("prefix").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("card_key_prefix_reservations_prefix_ck", sql`${t.prefix} ~ '^[A-Z][A-Z0-9]{1,9}$'`),
    primaryKey({ columns: [t.clientId, t.prefix] }),
    index("card_key_prefix_reservations_workspace_id_idx").on(t.workspaceId),
  ],
);

export type CardKeyPrefixReservation = typeof cardKeyPrefixReservations.$inferSelect;
