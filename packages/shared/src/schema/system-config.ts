import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const SYSTEM_CONFIG_ROW_ID = "default";

export const systemConfigs = pgTable("system_config", {
  id: text("id").primaryKey(),
  vapidSubject: text("vapid_subject"),
  vapidPublicKey: text("vapid_public_key"),
  vapidPrivateKey: text("vapid_private_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SystemConfig = typeof systemConfigs.$inferSelect;
export type NewSystemConfig = typeof systemConfigs.$inferInsert;