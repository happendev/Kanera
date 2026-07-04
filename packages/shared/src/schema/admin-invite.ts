import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { citext } from "./client.js";
import { adminUsers } from "./admin-user.js";

export const adminInvites = pgTable(
  "admin_invite",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    email: citext("email").notNull(),
    displayName: text("display_name").notNull(),
    tokenHash: text("token_hash").notNull(),
    invitedById: uuid("invited_by_id").notNull().references(() => adminUsers.id, { onDelete: "restrict" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("admin_invites_token_hash_uq").on(t.tokenHash),
    index("admin_invites_email_idx").on(t.email),
  ],
);

export type AdminInvite = typeof adminInvites.$inferSelect;
