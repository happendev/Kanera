import { sql } from "drizzle-orm";
import { check, date, integer, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { clients } from "./client.js";

// Organisation-level counters survive automation deletion and make the monthly allowance
// impossible to bypass by deleting and recreating rules. Periods are UTC calendar months.
export const automationMonthlyUsage = pgTable(
  "automation_monthly_usage",
  {
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    periodStart: date("period_start").notNull(),
    executionCount: integer("execution_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.clientId, t.periodStart] }),
    check("automation_monthly_usage_execution_count_ck", sql`${t.executionCount} >= 0`),
  ],
);

export type AutomationMonthlyUsage = typeof automationMonthlyUsage.$inferSelect;
