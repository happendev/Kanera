import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { boards } from "./board.js";
import { supportSessions } from "./support-session.js";
import { users } from "./user.js";
import { workspaceApiKeys } from "./workspace-api-key.js";
import { workspaces } from "./workspace.js";

export const ACTIVITY_ENTITY_TYPES = [
  "board",
  "boardGroup",
  "list",
  "card",
  "separator",
  "comment",
  "customField",
  "cardLabel",
  "workspace",
  "workspaceMember",
] as const;
export type ActivityEntityType = (typeof ACTIVITY_ENTITY_TYPES)[number];
export const ACTIVITY_ENTITY_TYPE = {
  BOARD: "board",
  BOARD_GROUP: "boardGroup",
  LIST: "list",
  CARD: "card",
  SEPARATOR: "separator",
  COMMENT: "comment",
  CUSTOM_FIELD: "customField",
  CARD_LABEL: "cardLabel",
  WORKSPACE: "workspace",
  WORKSPACE_MEMBER: "workspaceMember",
} as const satisfies Record<string, ActivityEntityType>;

export const ACTIVITY_ACTIONS = [
  "created",
  "updated",
  "moved",
  "deleted",
  "removed",
  "completed",
  "uncompleted",
  "archived",
  "unarchived",
  "completion:set",
  "overdue",
  "labels:set",
  "assignees:set",
  "customFieldValue:set",
  "customFieldValue:cleared",
  "checklist:created",
  "checklist:renamed",
  "checklist:deleted",
  "checklist:completed",
  "checklistItem:created",
  "checklistItem:updated",
  "checklistItem:deleted",
  "checklistItem:completion",
  "checklistItem:assignee:set",
  "checklistItem:dueDate:set",
  "checklistItem:description:set",
  "checklistTemplate:created",
  "checklistTemplate:updated",
  "checklistTemplate:deleted",
  "automation:created",
  "automation:updated",
  "automation:deleted",
  "attachment_added",
  "attachment_removed",
  "cover_set",
  "cover_removed",
  "added",
  "mirror:created",
  "mirror:updated",
  "mirror:deleted",
  "mirror:disabled",
  "mirror:enabled",
] as const;
export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];
export const ACTIVITY_ACTION = {
  CREATED: "created",
  UPDATED: "updated",
  MOVED: "moved",
  DELETED: "deleted",
  REMOVED: "removed",
  COMPLETED: "completed",
  UNCOMPLETED: "uncompleted",
  ARCHIVED: "archived",
  UNARCHIVED: "unarchived",
  COMPLETION_SET: "completion:set",
  OVERDUE: "overdue",
  LABELS_SET: "labels:set",
  ASSIGNEES_SET: "assignees:set",
  CUSTOM_FIELD_VALUE_SET: "customFieldValue:set",
  CUSTOM_FIELD_VALUE_CLEARED: "customFieldValue:cleared",
  CHECKLIST_CREATED: "checklist:created",
  CHECKLIST_RENAMED: "checklist:renamed",
  CHECKLIST_DELETED: "checklist:deleted",
  CHECKLIST_COMPLETED: "checklist:completed",
  CHECKLIST_ITEM_CREATED: "checklistItem:created",
  CHECKLIST_ITEM_UPDATED: "checklistItem:updated",
  CHECKLIST_ITEM_DELETED: "checklistItem:deleted",
  CHECKLIST_ITEM_COMPLETION: "checklistItem:completion",
  CHECKLIST_ITEM_ASSIGNEE_SET: "checklistItem:assignee:set",
  CHECKLIST_ITEM_DUE_DATE_SET: "checklistItem:dueDate:set",
  CHECKLIST_ITEM_DESCRIPTION_SET: "checklistItem:description:set",
  CHECKLIST_TEMPLATE_CREATED: "checklistTemplate:created",
  CHECKLIST_TEMPLATE_UPDATED: "checklistTemplate:updated",
  CHECKLIST_TEMPLATE_DELETED: "checklistTemplate:deleted",
  AUTOMATION_CREATED: "automation:created",
  AUTOMATION_UPDATED: "automation:updated",
  AUTOMATION_DELETED: "automation:deleted",
  ATTACHMENT_ADDED: "attachment_added",
  ATTACHMENT_REMOVED: "attachment_removed",
  COVER_SET: "cover_set",
  COVER_REMOVED: "cover_removed",
  ADDED: "added",
  MIRROR_CREATED: "mirror:created",
  MIRROR_UPDATED: "mirror:updated",
  MIRROR_DELETED: "mirror:deleted",
  MIRROR_DISABLED: "mirror:disabled",
  MIRROR_ENABLED: "mirror:enabled",
} as const satisfies Record<string, ActivityAction>;

export const ACTIVITY_COALESCE_KEYS = [
  "card:board",
  "card:assignees",
  "card:completion",
  "card:description",
  "card:labels",
  "card:title",
  "list:position",
  "list:update",
] as const;
export type ActivityCoalesceKey = (typeof ACTIVITY_COALESCE_KEYS)[number];
export const ACTIVITY_COALESCE_KEY = {
  CARD_BOARD: "card:board",
  CARD_ASSIGNEES: "card:assignees",
  CARD_COMPLETION: "card:completion",
  CARD_DESCRIPTION: "card:description",
  CARD_LABELS: "card:labels",
  CARD_TITLE: "card:title",
  LIST_POSITION: "list:position",
  LIST_UPDATE: "list:update",
} as const satisfies Record<string, ActivityCoalesceKey>;
export type DynamicActivityCoalesceKey =
  | `customField:${string}`
  | `checklist:${string}:title`
  | `checklist:${string}:completed`
  | `checklistItem:${string}:text`
  | `checklistItem:${string}:description`
  | `checklistItem:${string}:assignee`
  | `checklistItem:${string}:dueDate`
  | `checklist:${string}:items:assignee`
  | `checklist:${string}:items:dueDate`;

export const activityEvents = pgTable(
  "activity_event",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    boardId: uuid("board_id")
      .references(() => boards.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id")
      .references(() => users.id, { onDelete: "restrict" }),
    // "support" marks a mutation made during a superadmin support session. actorId still holds the
    // impersonated (acted-as) user so entity references stay valid; the operator's real identity lives
    // in supportSessionId + supportActorEmail so audit history never falsely reads as the owner acting.
    actorKind: text("actor_kind").$type<"user" | "apiKey" | "system" | "support">().notNull().default("user"),
    apiKeyId: uuid("api_key_id")
      .references(() => workspaceApiKeys.id, { onDelete: "set null" }),
    apiKeyName: text("api_key_name"),
    // Set only for support-session actions. The FK uses SET NULL (not cascade) so the durable
    // support_session audit row can be pruned without destroying operational activity; the email
    // snapshot keeps the operator identifiable even then.
    supportSessionId: uuid("support_session_id")
      .references(() => supportSessions.id, { onDelete: "set null" }),
    supportActorEmail: text("support_actor_email"),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    action: text("action").notNull(),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    feedVisible: boolean("feed_visible").notNull().default(true),
    coalesceKey: text("coalesce_key"),
    coalescedCount: integer("coalesced_count").notNull().default(1),
    coalescedUntil: timestamp("coalesced_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("activity_events_board_id_created_at_idx").on(t.boardId, t.createdAt),
    index("activity_events_workspace_id_created_at_idx").on(t.workspaceId, t.createdAt),
    index("activity_events_coalesce_probe_idx").on(
      t.workspaceId,
      t.actorId,
      t.actorKind,
      t.apiKeyId,
      t.entityType,
      t.entityId,
      t.action,
      t.coalesceKey,
      t.updatedAt,
    ),
  ],
);

export type ActivityEvent = typeof activityEvents.$inferSelect;
export type NewActivityEvent = typeof activityEvents.$inferInsert;
