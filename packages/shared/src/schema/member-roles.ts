// Roles are split by scope. Workspace membership is a two-tier model: `admin` manages everything
// workspace-scoped (config, lists, board creation, membership, board access, delete workspace),
// while `member` has no workspace-scoped mutation rights at all and exists only to be added to
// boards. Board membership is likewise two-tier: `editor` can mutate board content, `observer` is
// read-only. Workspace admins are materialized onto every board as pinned `editor` rows (see
// board-membership.ts), so boards themselves need no admin tier.
export const WORKSPACE_ROLES = ["admin", "member"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const BOARD_ROLES = ["editor", "observer"] as const;
export type BoardRole = (typeof BOARD_ROLES)[number];
