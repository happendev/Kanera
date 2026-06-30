import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { boards } from "./board.js";
import { clients } from "./client.js";
import { memberRole } from "./member-roles.js";
import { users } from "./user.js";

export const boardInvitations = pgTable(
  "board_invitation",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    boardId: uuid("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: memberRole("role").notNull().default("editor"),
    tokenHash: text("token_hash").notNull().unique(),
    invitedById: uuid("invited_by_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedByUserId: uuid("accepted_by_user_id").references(() => users.id, { onDelete: "set null" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("board_invitations_client_email_idx").on(t.clientId, sql`lower(${t.email})`),
    index("board_invitations_board_id_idx").on(t.boardId),
    index("board_invitations_token_hash_idx").on(t.tokenHash),
  ],
);

export type BoardInvitation = typeof boardInvitations.$inferSelect;
export type NewBoardInvitation = typeof boardInvitations.$inferInsert;
