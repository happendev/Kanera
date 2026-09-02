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
  BOARDS_COLLAPSED: "kanera_boards_collapsed",
  CARD_COMPOSER_DRAFTS: "kanera:card-composer-drafts",
  CARD_DETAIL_MODE: "kanera:card-detail-mode",
  CARD_LABELS_COMPRESSED: "kanera:card-labels-compressed",
  COLLAPSED_CHECKLISTS: "kanera:collapsed-checklists",
  EDITOR_DRAFTS: "kanera:editor-drafts",
  HIDE_COMPLETED_CHECKLIST_ITEMS: "kanera:hide-completed-checklist-items",
  LOGOUT_SYNC: "kanera-auth-logout",
  NOTES_SELECTION_PREFIX: "kanera.notes.selection",
  NOTES_TAB_PREFIX: "kanera.notes.tab",
  NOTIFICATION_BOARD_FILTER: "kanera:notif-board-filter",
  ONBOARDING_SKIPPED_PREFIX: "kanera.onboarding.skipped",
  NOTIFICATION_GROUP_BY: "kanera:notif-group-by",
  MENTION_SOUND_ENABLED: "kanera:mention-sound-enabled",
  NOTIFICATION_USER_FILTER: "kanera:notif-user-filter",
  PUSH_OPT_IN_PENDING: "kanera:push-opt-in-pending",
  RECENT_BOARDS: "kanera:recent-boards",
  // Panel open state and width are device-level (a wide monitor and a laptop want different widths),
  // so they are deliberately NOT per-user. The active tab is per-user and organisation — see
  // scratchpadActiveNoteKey.
  SCRATCHPAD_OPEN: "kanera:scratchpad-open",
  SCRATCHPAD_WIDTH: "kanera:scratchpad-width",
  // Sheet height is the phone-shaped counterpart to width: the same device-level geometry, for the
  // form the panel takes below the dock breakpoint.
  SCRATCHPAD_SHEET_HEIGHT: "kanera:scratchpad-sheet-height",
  SCRATCHPAD_ACTIVE_PREFIX: "kanera.scratchpad.active",
  SHARE_TARGET_DESTINATION: "kanera:share-target-destination",
  SIDEBAR_COLLAPSED: "kanera_sidebar_collapsed",
  WORKSPACES_COLLAPSED: "kanera_workspaces_collapsed",
  THEME: "kanera-theme",
  VIEW_PREFIX: "kanera.view",
} as const;

export type StorageKey =
  | (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS]
  | `kanera.notes.selection:${string}:${string}:${"personal" | "team"}`
  | `kanera.notes.tab:${string}:${string}`
  | `kanera.onboarding.skipped:${string}:${string}`
  | `kanera.scratchpad.active:${string}:${string}`
  | `kanera.view.${"aggregates" | "aggregateSplit" | "background" | "columnOrder" | "columnWidths" | "columns" | "completed" | "definition" | "filters" | "groupBy" | "mode" | "showSeparators" | "sort" | "upNextSeen"}:${string}`;

export function organisationStorageKey(key: StorageKey, clientId: string | null | undefined): string {
  return `${key}:${clientId ?? "anonymous"}`;
}

/**
 * Remembers that a first-run admin chose "Skip for now" on onboarding. Keyed by user and
 * organisation for the same reasons as scratchpadActiveNoteKey: a shared machine and an organisation
 * switch must each see their own decision.
 */
export function onboardingSkippedKey(userId: string, clientId: string): StorageKey {
  return `${STORAGE_KEYS.ONBOARDING_SKIPPED_PREFIX}:${userId}:${clientId}`;
}

export function notesTabKey(scopeId: string, workspaceId: string): StorageKey {
  return `${STORAGE_KEYS.NOTES_TAB_PREFIX}:${scopeId}:${workspaceId}`;
}

export function notesSelectionKey(
  scopeId: string,
  workspaceId: string,
  section: "personal" | "team",
): StorageKey {
  return `${STORAGE_KEYS.NOTES_SELECTION_PREFIX}:${scopeId}:${workspaceId}:${section}`;
}

/**
 * The remembered scratchpad tab, keyed by user and organisation.
 *
 * Both parts matter: a shared machine must not reuse another user's page id, and one user switching
 * organisations must not leave the new organisation's panel pointing at the old organisation's page.
 */
export function scratchpadActiveNoteKey(userId: string, clientId: string): StorageKey {
  return `${STORAGE_KEYS.SCRATCHPAD_ACTIVE_PREFIX}:${userId}:${clientId}`;
}

export function viewPreferenceKey(
  preference: "aggregates" | "aggregateSplit" | "background" | "columnOrder" | "columnWidths" | "columns" | "completed" | "definition" | "filters" | "groupBy" | "mode" | "showSeparators" | "sort" | "upNextSeen",
  scope: string,
): StorageKey {
  return `${STORAGE_KEYS.VIEW_PREFIX}.${preference}:${scope}`;
}
