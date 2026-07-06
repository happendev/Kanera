import { pgEnum } from "drizzle-orm/pg-core";

// Roles are split by scope. Workspace membership is a two-tier model: `admin` manages everything
// workspace-scoped (config, lists, board creation, membership, board access, delete workspace),
// while `member` has no workspace-scoped mutation rights at all and exists only to be added to
// boards. Board membership is likewise two-tier: `editor` can mutate board content, `observer` is
// read-only. Workspace admins are materialized onto every board as pinned `editor` rows (see
// board-membership.ts), so boards themselves need no admin tier.
export const workspaceRole = pgEnum("workspace_role", ["admin", "member"]);
export type WorkspaceRole = (typeof workspaceRole.enumValues)[number];

export const boardRole = pgEnum("board_role", ["editor", "observer"]);
export type BoardRole = (typeof boardRole.enumValues)[number];
