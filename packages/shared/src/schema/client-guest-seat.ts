import { index, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { clients } from "./client.js";
import { users } from "./user.js";

export const clientGuestSeats = pgTable(
  "client_guest_seat",
  {
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdById: uuid("created_by_id")
      .references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.clientId, t.userId] }),
    index("client_guest_seats_user_id_idx").on(t.userId),
    index("client_guest_seats_created_by_id_idx").on(t.createdById),
  ],
);

export type ClientGuestSeat = typeof clientGuestSeats.$inferSelect;
export type NewClientGuestSeat = typeof clientGuestSeats.$inferInsert;
