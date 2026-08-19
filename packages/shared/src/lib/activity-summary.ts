/* eslint-disable @typescript-eslint/dot-notation --
 * `payload` is an arbitrary activity JSON blob typed as Record<string, unknown>. The web app
 * compiles this file with noPropertyAccessFromIndexSignature, which requires bracket access
 * (TS4111), so dot notation is not available here even though this package's preset prefers it.
 */
import type { ActivityEvent } from "../schema/activity-event.js";
import type { NotificationReason } from "../schema/notification.js";

/** Precomputed action line for one notification, as the drawer renders it and push bodies read it. */
export interface ActivityChangeSummary {
  icon: string;
  text: string;
  value?: string;
}

/**
 * Structural subset of `NotificationRow`, so a `NotificationRow` is assignable as-is and the API
 * can summarise an enriched notification without materialising the full DTO.
 *
 * Both imports are type-only on purpose: the web bundle must not pull Drizzle in at runtime.
 */
export interface ActivityChangeSummaryInput {
  reason: NotificationReason;
  activity: Pick<ActivityEvent, "entityType" | "action" | "payload" | "actorKind" | "actorId"> | null;
  listName: string | null;
  actorName: string | null;
}

/**
 * Shared by the notification drawer and the watched-activity push builder so one activity reads
 * the same way wherever it surfaces. Keep it pure — the drawer memoises the result per row rather
 * than calling it from a template, because it is a long switch on a hot change-detection path.
 */
export function summariseActivityChange(input: ActivityChangeSummaryInput): ActivityChangeSummary {
  // Checklist-item overdue rows carry no activity, so this must precede the
  // generic overdue branch below (which would otherwise read as "card is overdue").
  if (input.reason === "checklist_item_overdue") {
    return { icon: "ti ti-calendar-exclamation", text: "checklist item is overdue" };
  }
  if (input.reason === "overdue" || !input.activity) {
    return { icon: "ti ti-calendar-exclamation", text: "card is overdue" };
  }
  const activity = input.activity;
  const payload = (activity.payload ?? {}) as Record<string, unknown>;
  switch (activity.entityType) {
    case "comment":
      return {
        icon: "ti ti-message-circle-2",
        text: activity.action === "created" ? "commented" : activity.action === "updated" ? "edited a comment" : "removed a comment",
      };
    case "card": {
      switch (activity.action) {
        case "created": {
          const copiedFrom = shortName(payload["duplicatedFromBoardName"]) ?? shortName(payload["duplicatedFromBoardId"]);
          if (copiedFrom) return { icon: "ti ti-copy", text: "copied this card from", value: copiedFrom };
          if (typeof payload["duplicatedFromId"] === "string") return { icon: "ti ti-copy", text: "copied this card from", value: "another board" };
          return { icon: "ti ti-plus", text: "created this card" };
        }
        case "deleted":
          return { icon: "ti ti-trash", text: "deleted this card" };
        case "moved":
          return { icon: "ti ti-arrows-right-left", text: "moved this card to", value: input.listName ?? "another list" };
        case "completed":
          return { icon: "ti ti-circle-check", text: "marked this card complete" };
        case "uncompleted":
          return { icon: "ti ti-circle", text: "marked this card incomplete" };
        case "completion:set":
          return {
            icon: payload["toValue"] === true ? "ti ti-circle-check" : "ti ti-circle",
            text: payload["toValue"] === true ? "marked this card complete" : "marked this card incomplete",
          };
        case "attachment_added":
          return { icon: "ti ti-paperclip", text: `attached ${shortName(payload["fileName"]) ?? "a file"}` };
        case "attachment_removed":
          return { icon: "ti ti-paperclip", text: `removed an attachment` };
        case "assignees:set": {
          const added = (payload["addedAssigneeNames"] as string[]) ?? [];
          const removed = (payload["removedAssigneeNames"] as string[]) ?? [];
          const parts: string[] = [];
          if (added.length) parts.push(addedSelf(payload, activity, input.actorName) ? "assigned themself" : `assigned ${added.join(", ")}`);
          if (removed.length) parts.push(`unassigned ${removed.join(", ")}`);
          return { icon: "ti ti-user", text: parts.join(" · ") || "changed assignees" };
        }
        case "labels:set": {
          const added = (payload["addedLabelNames"] as string[]) ?? [];
          const removed = (payload["removedLabelNames"] as string[]) ?? [];
          const parts: string[] = [];
          if (added.length) parts.push(`added label ${added.join(", ")}`);
          if (removed.length) parts.push(`removed label ${removed.join(", ")}`);
          return { icon: "ti ti-tag", text: parts.join(" · ") || "updated labels" };
        }
        case "updated": {
          const title = payload["title"];
          const description = payload["description"];
          if (typeof title === "string") return { icon: "ti ti-pencil", text: `renamed to "${title}"` };
          if (description !== undefined) return { icon: "ti ti-pencil", text: "edited the description" };
          if (payload["dueDateLocalDate"] !== undefined) return { icon: "ti ti-calendar", text: payload["dueDateLocalDate"] ? "updated the due date" : "removed the due date" };
          return { icon: "ti ti-pencil", text: "updated this card" };
        }
        case "customFieldValue:set": {
          const name = (payload["fieldName"] as string) ?? "field";
          const raw = payload["toValue"];
          if (raw == null || raw === "") return { icon: "ti ti-forms", text: `cleared ${name}` };
          let to = "";
          if (typeof raw === "string") to = raw;
          else if (typeof raw === "number" || typeof raw === "boolean") to = String(raw);
          else if (raw != null) to = JSON.stringify(raw);
          return { icon: "ti ti-forms", text: `set ${name} to`, value: shortName(to) ?? undefined };
        }
        case "cover_set":
          return { icon: "ti ti-photo", text: "set the cover image" };
        case "cover_removed":
          return { icon: "ti ti-photo-off", text: "removed the cover image" };
        case "checklist:created":
          return { icon: "ti ti-list-check", text: "added checklist", value: shortName(payload["title"]) ?? undefined };
        case "checklist:deleted":
          return { icon: "ti ti-trash", text: "deleted checklist", value: shortName(payload["title"]) ?? undefined };
        case "checklist:completed": {
          const title = shortName(payload["title"]);
          const parentItemText = shortName(payload["parentItemText"]);
          if (parentItemText) {
            return {
              icon: "ti ti-circle-check",
              text: "completed sub-checklist",
              value: title ? `${title} on ${parentItemText}` : `on ${parentItemText}`,
            };
          }
          return { icon: "ti ti-circle-check", text: "completed checklist", value: title ?? undefined };
        }
        case "checklist:renamed":
          return { icon: "ti ti-pencil", text: "renamed checklist to", value: shortName(payload["toValue"]) ?? undefined };
        case "checklistItem:updated":
          return { icon: "ti ti-pencil", text: "edited checklist item", value: shortName(payload["toValue"]) ?? undefined };
        case "checklistItem:description:set":
          return { icon: "ti ti-align-left", text: payload["toValue"] ? "updated a checklist item description" : "cleared a checklist item description", value: shortName(payload["itemText"]) ?? undefined };
        case "checklistItem:assignee:set": {
          const assigneeName = typeof payload["assigneeName"] === "string" ? payload["assigneeName"] : null;
          const previousAssigneeName = typeof payload["previousAssigneeName"] === "string" ? payload["previousAssigneeName"] : null;
          return {
            icon: "ti ti-user-check",
            text: assigneeName && previousAssigneeName
              ? `changed assignee from ${previousAssigneeName} to ${assigneeName}`
              : assigneeName ? `assigned ${assigneeName} to checklist item` : "unassigned checklist item",
            value: shortName(payload["itemText"]) ?? undefined,
          };
        }
        case "checklistItem:completion":
          return {
            icon: payload["toValue"] === true ? "ti ti-checkbox" : "ti ti-square",
            text: payload["toValue"] === true ? "completed checklist item" : "marked checklist item incomplete",
            value: shortName(payload["text"]) ?? undefined,
          };
        case "checklistItem:created":
          return { icon: "ti ti-list-check", text: "added checklist item", value: shortName(payload["text"]) ?? undefined };
        case "checklistItem:deleted":
          return { icon: "ti ti-trash", text: "deleted checklist item", value: shortName(payload["text"]) ?? undefined };
        default:
          return { icon: "ti ti-history", text: humanizeAction(activity.action) };
      }
    }
    default:
      return { icon: "ti ti-history", text: humanizeAction(activity.action) };
  }
}

function shortName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length <= 40) return value;
  return value.slice(0, 37) + "…";
}

function activityPayloadNames(payload: Record<string, unknown>, key: string): string[] {
  const names = payload[key];
  if (!Array.isArray(names)) return [];
  return names.filter((name): name is string => typeof name === "string" && name.length > 0);
}

function addedSelf(
  payload: Record<string, unknown>,
  activity: ActivityChangeSummaryInput["activity"],
  actorName: string | null,
): boolean {
  if (!activity || activity.actorKind !== "user" || !activity.actorId) return false;

  const fromValue = activityPayloadNames(payload, "fromValue");
  const toValue = activityPayloadNames(payload, "toValue");
  if (toValue.length > 0) {
    return toValue.includes(activity.actorId) && !fromValue.includes(activity.actorId);
  }

  const addedIds = activityPayloadNames(payload, "addedAssigneeIds");
  if (addedIds.length > 0) return addedIds.length === 1 && addedIds[0] === activity.actorId;

  const addedNames = activityPayloadNames(payload, "addedAssigneeNames");
  return addedNames.length === 1 && addedNames[0] === actorName;
}

function humanizeAction(action: string): string {
  return action
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[:_]+/g, " ")
    .toLowerCase();
}
