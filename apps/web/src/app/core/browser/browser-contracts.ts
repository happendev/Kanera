export const APP_DOM_EVENTS = {
  CARD_ACTIONS_MENU_OPEN: "kanera:card-actions-menu-open",
  CARD_LABELS_DISPLAY_CHANGED: "kanera:card-labels-display-changed",
  CARD_DRAG_LEAVE_LIST: "kanera:card-drag-leave-list",
  CARD_DRAG_MOVE: "kanera:card-drag-move",
  CARD_DRAG_OVER_LIST: "kanera:card-drag-over-list",
  CARD_DRAG_STATE: "kanera:card-drag-state",
  CARD_DROP_TARGET: "kanera:card-drop-target",
  CARD_DROP_SOURCE_COMMITTED: "kanera:card-drop-source-committed",
  LIST_MENU_OPEN: "kanera:list-menu-open",
  PUSH_SUBSCRIPTION_CHANGED: "kanera:pushsubscriptionchange",
} as const;

export const STORAGE_KEYS = {
  BOARD_GROUPS_COLLAPSED: "kanera_board_groups_collapsed",
  ACTIVE_CARD_VIEWS: "kanera:active-card-views",
  ASSIGNED_WORK_CHECKLIST_COLLAPSED_PREFIX: "kanera:assigned-work-checklist-collapsed",
  ASSIGNED_WORK_TEAM_USER_PREFIX: "kanera:assigned-work-team-user",
  BOARDS_COLLAPSED: "kanera_boards_collapsed",
  CARD_DETAIL_MODE: "kanera:card-detail-mode",
  CARD_LABELS_COMPRESSED: "kanera:card-labels-compressed",
  COLLAPSED_CHECKLISTS: "kanera:collapsed-checklists",
  EDITOR_DRAFTS: "kanera:editor-drafts",
  HIDE_COMPLETED_CHECKLIST_ITEMS: "kanera:hide-completed-checklist-items",
  LOGOUT_SYNC: "kanera-auth-logout",
  NOTES_TAB_PREFIX: "kanera.notes.tab",
  NOTIFICATION_BOARD_FILTER: "kanera:notif-board-filter",
  NOTIFICATION_GROUP_BY: "kanera:notif-group-by",
  MENTION_SOUND_ENABLED: "kanera:mention-sound-enabled",
  NOTIFICATION_USER_FILTER: "kanera:notif-user-filter",
  PUSH_OPT_IN_PENDING: "kanera:push-opt-in-pending",
  RECENT_BOARDS: "kanera:recent-boards",
  SIDEBAR_COLLAPSED: "kanera_sidebar_collapsed",
  WORKSPACES_COLLAPSED: "kanera_workspaces_collapsed",
  THEME: "kanera-theme",
  VIEW_PREFIX: "kanera.view",
} as const;

export type StorageKey =
  | (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS]
  | `${typeof STORAGE_KEYS.ASSIGNED_WORK_CHECKLIST_COLLAPSED_PREFIX}:${string}:${"me" | "team"}`
  | `${typeof STORAGE_KEYS.ASSIGNED_WORK_TEAM_USER_PREFIX}:${string}`
  | `kanera.notes.tab:${string}:${string}`
  | `kanera.view.${"aggregates" | "aggregateSplit" | "background" | "columnOrder" | "columnWidths" | "columns" | "completed" | "filters" | "groupBy" | "mode" | "showSeparators" | "sort"}:${string}`;

export function notesTabKey(scopeId: string, workspaceId: string): StorageKey {
  return `${STORAGE_KEYS.NOTES_TAB_PREFIX}:${scopeId}:${workspaceId}`;
}

export function assignedWorkTeamUserKey(workspaceId: string): StorageKey {
  return `${STORAGE_KEYS.ASSIGNED_WORK_TEAM_USER_PREFIX}:${workspaceId}`;
}

export function viewPreferenceKey(
  preference: "aggregates" | "aggregateSplit" | "background" | "columnOrder" | "columnWidths" | "columns" | "completed" | "filters" | "groupBy" | "mode" | "showSeparators" | "sort",
  scope: string,
): StorageKey {
  return `${STORAGE_KEYS.VIEW_PREFIX}.${preference}:${scope}`;
}
