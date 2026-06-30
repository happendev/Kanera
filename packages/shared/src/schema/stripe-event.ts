import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const stripeEvents = pgTable(
  "stripe_event",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("stripe_events_created_at_idx").on(t.createdAt),
  ],
);

export type StripeEvent = typeof stripeEvents.$inferSelect;
export type NewStripeEvent = typeof stripeEvents.$inferInsert;
