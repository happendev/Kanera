import { check, index, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { valueIn } from "./_value-check.js";
import { boards } from "./board.js";
import { inviteTokens } from "./invite-token.js";
import { BOARD_ROLES } from "./member-roles.js";

// Board access an organisation invite hands out on acceptance. Workspace membership alone grants no
// board content, so without these rows an invited member lands with nothing to open. Deleting a board
// cascades its grants away, so acceptance never resurrects access to a board that no longer exists.
export const inviteBoardGrants = pgTable(
  "invite_board_grant",
  {
    inviteId: uuid("invite_id")
      .notNull()
      .references(() => inviteTokens.id, { onDelete: "cascade" }),
    boardId: uuid("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    role: text("role", { enum: BOARD_ROLES }).notNull().default("editor"),
  },
  (t) => [
    check("invite_board_grants_role_ck", valueIn(t.role, BOARD_ROLES)),
    primaryKey({ columns: [t.inviteId, t.boardId] }),
    index("invite_board_grants_board_id_idx").on(t.boardId),
  ],
);

export type InviteBoardGrant = typeof inviteBoardGrants.$inferSelect;
