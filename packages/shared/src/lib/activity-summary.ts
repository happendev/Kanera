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
 * The words of an activity summary, so the web app (`$localize`) and the API (per-recipient
 * catalogs for push) can each supply their language.
 *
 * Every entry is a *predicate* that reads after the actor's name, which the drawer renders separately
 * in bold ("Priya · moved this card to [Doing]"); `value`, when present, is shown after it as a chip.
 * Translations keep that shape: a phrase that follows the actor, in the language's natural form.
 * Names passed in are user content: insert them, never translate them.
 */
export interface ActivitySummaryMessages {
  reminder: string;
  checklistItemOverdue: string;
  cardOverdue: string;
  commented: string;
  editedComment: string;
  removedComment: string;
  copiedCardFrom: string;
  anotherBoard: string;
  createdCard: string;
  deletedCard: string;
  movedCardTo: string;
  anotherList: string;
  markedComplete: string;
  markedIncomplete: string;
  attached: (fileName: string) => string;
  reactedToComment: string;
  reactedToAttachment: (fileName: string) => string;
  /** A dependency on the watched card; the other card's key follows as the chip. */
  markedBlockedBy: string;
  markedBlocking: string;
  relatedTo: string;
  /** The assigned or watched card's last blocker closed; that blocker's key follows as the chip. */
  clearedLastBlocker: string;
  /** A blocker of the assigned or watched card was reopened; that blocker's key follows as the chip. */
  reopenedBlocker: string;
  attachedFile: string;
  removedAttachment: string;
  assignedSelf: string;
  assigned: (names: string) => string;
  unassigned: (names: string) => string;
  changedAssignees: string;
  addedLabels: (names: string) => string;
  removedLabels: (names: string) => string;
  updatedLabels: string;
  renamedTo: (title: string) => string;
  editedDescription: string;
  updatedDueDate: string;
  removedDueDate: string;
  updatedStartDate: string;
  removedStartDate: string;
  rescheduled: string;
  updatedCard: string;
  clearedField: (fieldName: string) => string;
  /** Fallback field name when the payload has none. */
  field: string;
  setFieldTo: (fieldName: string) => string;
  setCover: string;
  removedCover: string;
  correctedTimeInProgress: string;
  /** After the system's name ("Kanera"): the card's current stint passed its workspace alert. */
  flaggedInProgressTooLong: (days: number) => string;
  addedChecklist: string;
  deletedChecklist: string;
  completedSubChecklist: string;
  /** Chip for a sub-checklist: "{title} on {item}", or "on {item}" when untitled. */
  subChecklistOn: (title: string | null, parentItem: string) => string;
  completedChecklist: string;
  renamedChecklistTo: string;
  editedChecklistItem: string;
  updatedChecklistItemDescription: string;
  clearedChecklistItemDescription: string;
  changedChecklistItemAssignee: (from: string, to: string) => string;
  assignedChecklistItem: (name: string) => string;
  unassignedChecklistItem: string;
  completedChecklistItem: string;
  uncompletedChecklistItem: string;
  addedChecklistItem: string;
  deletedChecklistItem: string;
  /** An action this build has no words for; `action` is a humanised internal name. */
  otherAction: (action: string) => string;
  /** Joins names: "Ana, Ben and Chen" in each language's own style. */
  list: (names: string[]) => string;
}

/** The source (UK English) wording. */
export const ACTIVITY_SUMMARY_SOURCE_MESSAGES: ActivitySummaryMessages = {
  reminder: "reminder",
  checklistItemOverdue: "checklist item is overdue",
  cardOverdue: "card is overdue",
  commented: "commented",
  editedComment: "edited a comment",
  removedComment: "removed a comment",
  copiedCardFrom: "copied this card from",
  anotherBoard: "another board",
  createdCard: "created this card",
  deletedCard: "deleted this card",
  movedCardTo: "moved this card to",
  anotherList: "another list",
  markedComplete: "marked this card complete",
  markedIncomplete: "marked this card incomplete",
  attached: (fileName) => `attached ${fileName}`,
  reactedToComment: "gave your comment a thumbs-up",
  reactedToAttachment: (fileName) => `gave ${fileName} a thumbs-up`,
  markedBlockedBy: "marked this card as blocked by",
  markedBlocking: "marked this card as blocking",
  relatedTo: "related this card to",
  clearedLastBlocker: "cleared the last blocker on this card",
  reopenedBlocker: "reopened a blocker on this card",
  attachedFile: "attached a file",
  removedAttachment: "removed an attachment",
  assignedSelf: "assigned themself",
  assigned: (names) => `assigned ${names}`,
  unassigned: (names) => `unassigned ${names}`,
  changedAssignees: "changed assignees",
  addedLabels: (names) => `added label ${names}`,
  removedLabels: (names) => `removed label ${names}`,
  updatedLabels: "updated labels",
  renamedTo: (title) => `renamed to "${title}"`,
  editedDescription: "edited the description",
  updatedDueDate: "updated the due date",
  removedDueDate: "removed the due date",
  updatedStartDate: "updated the start date",
  removedStartDate: "removed the start date",
  rescheduled: "rescheduled the card",
  updatedCard: "updated this card",
  clearedField: (fieldName) => `cleared ${fieldName}`,
  field: "field",
  setFieldTo: (fieldName) => `set ${fieldName} to`,
  setCover: "set the cover image",
  removedCover: "removed the cover image",
  correctedTimeInProgress: "corrected the time in progress",
  flaggedInProgressTooLong: (days) => `flagged this card as in progress for more than ${days} ${days === 1 ? "day" : "days"}`,
  addedChecklist: "added checklist",
  deletedChecklist: "deleted checklist",
  completedSubChecklist: "completed sub-checklist",
  subChecklistOn: (title, parentItem) => (title ? `${title} on ${parentItem}` : `on ${parentItem}`),
  completedChecklist: "completed checklist",
  renamedChecklistTo: "renamed checklist to",
  editedChecklistItem: "edited checklist item",
  updatedChecklistItemDescription: "updated a checklist item description",
  clearedChecklistItemDescription: "cleared a checklist item description",
  changedChecklistItemAssignee: (from, to) => `changed assignee from ${from} to ${to}`,
  assignedChecklistItem: (name) => `assigned ${name} to checklist item`,
  unassignedChecklistItem: "unassigned checklist item",
  completedChecklistItem: "completed checklist item",
  uncompletedChecklistItem: "marked checklist item incomplete",
  addedChecklistItem: "added checklist item",
  deletedChecklistItem: "deleted checklist item",
  otherAction: (action) => action,
  list: (names) => names.join(", "),
};

/**
 * Shared by the notification drawer and the watched-activity push builder so one activity reads
 * the same way wherever it surfaces. Keep it pure — the drawer memoises the result per row rather
 * than calling it from a template, because it is a long switch on a hot change-detection path.
 */
export function summariseActivityChange(
  input: ActivityChangeSummaryInput,
  m: ActivitySummaryMessages = ACTIVITY_SUMMARY_SOURCE_MESSAGES,
): ActivityChangeSummary {
  // Checklist-item overdue rows carry no activity, so this must precede the
  // generic overdue branch below (which would otherwise read as "card is overdue").
  // Reminders are the viewer's own alarm and carry no activity either.
  if (input.reason === "reminder") {
    return { icon: "ti ti-alarm", text: m.reminder };
  }
  if (input.reason === "checklist_item_overdue") {
    return { icon: "ti ti-calendar-exclamation", text: m.checklistItemOverdue };
  }
  if (input.reason === "overdue" || !input.activity) {
    return { icon: "ti ti-calendar-exclamation", text: m.cardOverdue };
  }
  const activity = input.activity;
  const payload = (activity.payload ?? {}) as Record<string, unknown>;
  // Only the author or uploader receives these, so the copy can say "your".
  if (activity.action === "reaction:added") {
    const fileName = shortName(payload["fileName"]);
    return {
      icon: "ti ti-thumb-up",
      text: activity.entityType === "comment" ? m.reactedToComment : m.reactedToAttachment(fileName ?? "…"),
    };
  }
  switch (activity.entityType) {
    case "comment":
      return {
        icon: "ti ti-message-circle-2",
        text: activity.action === "created" ? m.commented : activity.action === "updated" ? m.editedComment : m.removedComment,
      };
    case "card": {
      switch (activity.action) {
        case "created": {
          const copiedFrom = shortName(payload["duplicatedFromBoardName"]) ?? shortName(payload["duplicatedFromBoardId"]);
          if (copiedFrom) return { icon: "ti ti-copy", text: m.copiedCardFrom, value: copiedFrom };
          if (typeof payload["duplicatedFromId"] === "string") return { icon: "ti ti-copy", text: m.copiedCardFrom, value: m.anotherBoard };
          return { icon: "ti ti-plus", text: m.createdCard };
        }
        case "deleted":
          return { icon: "ti ti-trash", text: m.deletedCard };
        case "moved":
          return { icon: "ti ti-arrows-right-left", text: m.movedCardTo, value: input.listName ?? m.anotherList };
        case "completed":
          return { icon: "ti ti-circle-check", text: m.markedComplete };
        case "uncompleted":
          return { icon: "ti ti-circle", text: m.markedIncomplete };
        case "completion:set":
          return {
            icon: payload["toValue"] === true ? "ti ti-circle-check" : "ti ti-circle",
            text: payload["toValue"] === true ? m.markedComplete : m.markedIncomplete,
          };
        case "attachment_added": {
          const fileName = shortName(payload["fileName"]);
          return { icon: "ti ti-paperclip", text: fileName ? m.attached(fileName) : m.attachedFile };
        }
        case "attachment_removed":
          return { icon: "ti ti-paperclip", text: m.removedAttachment };
        case "assignees:set": {
          const added = (payload["addedAssigneeNames"] as string[]) ?? [];
          const removed = (payload["removedAssigneeNames"] as string[]) ?? [];
          const parts: string[] = [];
          if (added.length) parts.push(addedSelf(payload, activity, input.actorName) ? m.assignedSelf : m.assigned(m.list(added)));
          if (removed.length) parts.push(m.unassigned(m.list(removed)));
          return { icon: "ti ti-user", text: parts.join(" · ") || m.changedAssignees };
        }
        case "labels:set": {
          const added = (payload["addedLabelNames"] as string[]) ?? [];
          const removed = (payload["removedLabelNames"] as string[]) ?? [];
          const parts: string[] = [];
          if (added.length) parts.push(m.addedLabels(m.list(added)));
          if (removed.length) parts.push(m.removedLabels(m.list(removed)));
          return { icon: "ti ti-tag", text: parts.join(" · ") || m.updatedLabels };
        }
        case "updated": {
          const title = payload["title"];
          const description = payload["description"];
          if (typeof title === "string") return { icon: "ti ti-pencil", text: m.renamedTo(title) };
          if (description !== undefined) return { icon: "ti ti-pencil", text: m.editedDescription };
          // A Timeline drag moves both ends at once; one line reads better than two.
          if (payload["dueDateLocalDate"] !== undefined && payload["startDateLocalDate"] !== undefined) return { icon: "ti ti-calendar", text: m.rescheduled };
          if (payload["dueDateLocalDate"] !== undefined) return { icon: "ti ti-calendar", text: payload["dueDateLocalDate"] ? m.updatedDueDate : m.removedDueDate };
          if (payload["startDateLocalDate"] !== undefined) return { icon: "ti ti-calendar", text: payload["startDateLocalDate"] ? m.updatedStartDate : m.removedStartDate };
          return { icon: "ti ti-pencil", text: m.updatedCard };
        }
        case "customFieldValue:set": {
          const name = (payload["fieldName"] as string) ?? m.field;
          const raw = payload["toValue"];
          if (raw == null || raw === "") return { icon: "ti ti-forms", text: m.clearedField(name) };
          let to = "";
          if (typeof raw === "string") to = raw;
          else if (typeof raw === "number" || typeof raw === "boolean") to = String(raw);
          else if (raw != null) to = JSON.stringify(raw);
          return { icon: "ti ti-forms", text: m.setFieldTo(name), value: shortName(to) ?? undefined };
        }
        case "relation:added": {
          // Key only: the drawer may be read by someone who cannot open the other card.
          const value = shortName(payload["otherCardKey"]) ?? undefined;
          if (payload["direction"] === "blocked_by") return { icon: "ti ti-lock", text: m.markedBlockedBy, value };
          if (payload["direction"] === "blocks") return { icon: "ti ti-lock", text: m.markedBlocking, value };
          return { icon: "ti ti-git-merge", text: m.relatedTo, value };
        }
        case "blockers:cleared":
          // Key only, like relation:added: the recipient may not be able to open the blocker.
          return { icon: "ti ti-lock-open", text: m.clearedLastBlocker, value: shortName(payload["otherCardKey"]) ?? undefined };
        case "blockers:reopened":
          return { icon: "ti ti-lock", text: m.reopenedBlocker, value: shortName(payload["otherCardKey"]) ?? undefined };
        case "cover_set":
          return { icon: "ti ti-photo", text: m.setCover };
        case "cover_removed":
          return { icon: "ti ti-photo-off", text: m.removedCover };
        case "inProgressTime:set":
          return { icon: "ti ti-progress", text: m.correctedTimeInProgress };
        case "inProgress:tooLong":
          return { icon: "ti ti-progress-alert", text: m.flaggedInProgressTooLong(Number(payload["alertDays"]) || 0) };
        case "checklist:created":
          return { icon: "ti ti-list-check", text: m.addedChecklist, value: shortName(payload["title"]) ?? undefined };
        case "checklist:deleted":
          return { icon: "ti ti-trash", text: m.deletedChecklist, value: shortName(payload["title"]) ?? undefined };
        case "checklist:completed": {
          const title = shortName(payload["title"]);
          const parentItemText = shortName(payload["parentItemText"]);
          if (parentItemText) {
            return {
              icon: "ti ti-circle-check",
              text: m.completedSubChecklist,
              value: m.subChecklistOn(title, parentItemText),
            };
          }
          return { icon: "ti ti-circle-check", text: m.completedChecklist, value: title ?? undefined };
        }
        case "checklist:renamed":
          return { icon: "ti ti-pencil", text: m.renamedChecklistTo, value: shortName(payload["toValue"]) ?? undefined };
        case "checklistItem:updated":
          return { icon: "ti ti-pencil", text: m.editedChecklistItem, value: shortName(payload["toValue"]) ?? undefined };
        case "checklistItem:description:set":
          return { icon: "ti ti-align-left", text: payload["toValue"] ? m.updatedChecklistItemDescription : m.clearedChecklistItemDescription, value: shortName(payload["itemText"]) ?? undefined };
        case "checklistItem:assignee:set": {
          const assigneeName = typeof payload["assigneeName"] === "string" ? payload["assigneeName"] : null;
          const previousAssigneeName = typeof payload["previousAssigneeName"] === "string" ? payload["previousAssigneeName"] : null;
          return {
            icon: "ti ti-user-check",
            text: assigneeName && previousAssigneeName
              ? m.changedChecklistItemAssignee(previousAssigneeName, assigneeName)
              : assigneeName ? m.assignedChecklistItem(assigneeName) : m.unassignedChecklistItem,
            value: shortName(payload["itemText"]) ?? undefined,
          };
        }
        case "checklistItem:completion":
          return {
            icon: payload["toValue"] === true ? "ti ti-checkbox" : "ti ti-square",
            text: payload["toValue"] === true ? m.completedChecklistItem : m.uncompletedChecklistItem,
            value: shortName(payload["text"]) ?? undefined,
          };
        case "checklistItem:created":
          return { icon: "ti ti-list-check", text: m.addedChecklistItem, value: shortName(payload["text"]) ?? undefined };
        case "checklistItem:deleted":
          return { icon: "ti ti-trash", text: m.deletedChecklistItem, value: shortName(payload["text"]) ?? undefined };
        default:
          return { icon: "ti ti-history", text: m.otherAction(humanizeAction(activity.action)) };
      }
    }
    default:
      return { icon: "ti ti-history", text: m.otherAction(humanizeAction(activity.action)) };
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
