import { boolean, check, index, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { valueIn } from "./_value-check.js";
import { boards } from "./board.js";
import { boardInvitations } from "./board-invitation.js";
import { BOARD_ROLES } from "./member-roles.js";

export const boardInvitationGrants = pgTable(
  "board_invitation_grant",
  {
    invitationId: uuid("invitation_id")
      .notNull()
      .references(() => boardInvitations.id, { onDelete: "cascade" }),
    boardId: uuid("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    role: text("role", { enum: BOARD_ROLES }).notNull().default("editor"),
    assignedItemsOnly: boolean("assigned_items_only").notNull().default(false),
  },
  (t) => [
    check("board_invitation_grants_role_ck", valueIn(t.role, BOARD_ROLES)),
    primaryKey({ columns: [t.invitationId, t.boardId] }),
    index("board_invitation_grants_board_id_idx").on(t.boardId),
  ],
);

export type BoardInvitationGrant = typeof boardInvitationGrants.$inferSelect;
