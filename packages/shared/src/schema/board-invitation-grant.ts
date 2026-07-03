import { index, pgTable, primaryKey, uuid } from "drizzle-orm/pg-core";
import { boards } from "./board.js";
import { boardInvitations } from "./board-invitation.js";
import { boardRole } from "./member-roles.js";

export const boardInvitationGrants = pgTable(
  "board_invitation_grant",
  {
    invitationId: uuid("invitation_id")
      .notNull()
      .references(() => boardInvitations.id, { onDelete: "cascade" }),
    boardId: uuid("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    role: boardRole("role").notNull().default("editor"),
  },
  (t) => [
    primaryKey({ columns: [t.invitationId, t.boardId] }),
    index("board_invitation_grants_board_id_idx").on(t.boardId),
  ],
);

export type BoardInvitationGrant = typeof boardInvitationGrants.$inferSelect;
export type NewBoardInvitationGrant = typeof boardInvitationGrants.$inferInsert;
