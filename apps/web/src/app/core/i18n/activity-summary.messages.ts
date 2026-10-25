import type { ActivitySummaryMessages } from "@kanera/shared/activity-summary";
import { appLocale } from "./locale";
import { icu } from "./icu";

/**
 * The notification drawer's wording for `summariseActivityChange`. Each phrase follows the actor's
 * name, which the drawer renders separately ("Priya · moved this card to [Doing]"); see
 * ActivitySummaryMessages for the contract. The API keeps the same phrases per language for push.
 */
let listFormat: Intl.ListFormat | null = null;

export const ACTIVITY_SUMMARY_MESSAGES: ActivitySummaryMessages = {
  reminder: $localize`:Notification line for the viewer's own card reminder:reminder`,
  checklistItemOverdue: $localize`:Notification line:checklist item is overdue`,
  cardOverdue: $localize`:Notification line:card is overdue`,
  commented: $localize`:Notification line after a person's name:commented`,
  editedComment: $localize`:Notification line after a person's name:edited a comment`,
  removedComment: $localize`:Notification line after a person's name:removed a comment`,
  copiedCardFrom: $localize`:Notification line after a person's name; a board name follows:copied this card from`,
  anotherBoard: $localize`:Stand-in when the source board is unknown:another board`,
  createdCard: $localize`:Notification line after a person's name:created this card`,
  deletedCard: $localize`:Notification line after a person's name:deleted this card`,
  movedCardTo: $localize`:Notification line after a person's name; a list name follows:moved this card to`,
  anotherList: $localize`:Stand-in when the destination list is unknown:another list`,
  markedComplete: $localize`:Notification line after a person's name:marked this card complete`,
  markedIncomplete: $localize`:Notification line after a person's name:marked this card incomplete`,
  attached: (fileName) => $localize`:Notification line after a person's name:attached ${fileName}:fileName:`,
  attachedFile: $localize`:Notification line after a person's name:attached a file`,
  reactedToComment: $localize`:Notification line after a person's name; only the comment's author sees it:gave your comment a thumbs-up`,
  reactedToAttachment: (fileName) => $localize`:Notification line after a person's name; only the uploader sees it:gave ${fileName}:fileName: a thumbs-up`,
  markedBlockedBy: $localize`:Notification line after a person's name; the other card's key follows as a chip:marked this card as blocked by`,
  markedBlocking: $localize`:Notification line after a person's name; the other card's key follows as a chip:marked this card as blocking`,
  relatedTo: $localize`:Notification line after a person's name; the other card's key follows as a chip:related this card to`,
  clearedLastBlocker: $localize`:Notification line after a person's name - they finished the last card blocking a card the viewer is assigned to or watches; that blocker's key follows as a chip:cleared the last blocker on this card`,
  reopenedBlocker: $localize`:Notification line after a person's name - they reopened a card that blocks a card the viewer is assigned to or watches, so it is blocked again; that blocker's key follows as a chip:reopened a blocker on this card`,
  removedAttachment: $localize`:Notification line after a person's name:removed an attachment`,
  assignedSelf: $localize`:Notification line after a person's name; they assigned the card to themselves:assigned themself`,
  assigned: (names) => $localize`:Notification line after a person's name:assigned ${names}:names:`,
  unassigned: (names) => $localize`:Notification line after a person's name:unassigned ${names}:names:`,
  changedAssignees: $localize`:Notification line after a person's name:changed assignees`,
  addedLabels: (names) => $localize`:Notification line after a person's name:added label ${names}:labels:`,
  removedLabels: (names) => $localize`:Notification line after a person's name:removed label ${names}:labels:`,
  updatedLabels: $localize`:Notification line after a person's name:updated labels`,
  renamedTo: (title) => $localize`:Notification line after a person's name:renamed to "${title}:title:"`,
  editedDescription: $localize`:Notification line after a person's name:edited the description`,
  updatedDueDate: $localize`:Notification line after a person's name:updated the due date`,
  removedDueDate: $localize`:Notification line after a person's name:removed the due date`,
  updatedStartDate: $localize`:Notification line after a person's name:updated the start date`,
  removedStartDate: $localize`:Notification line after a person's name:removed the start date`,
  rescheduled: $localize`:Notification line after a person's name - both the start and due dates changed:rescheduled the card`,
  updatedCard: $localize`:Notification line after a person's name:updated this card`,
  clearedField: (fieldName) => $localize`:Notification line after a person's name; a custom field name follows:cleared ${fieldName}:fieldName:`,
  field: $localize`:Stand-in for an unnamed custom field:field`,
  setFieldTo: (fieldName) => $localize`:Notification line after a person's name; the new value follows:set ${fieldName}:fieldName: to`,
  setCover: $localize`:Notification line after a person's name:set the cover image`,
  removedCover: $localize`:Notification line after a person's name:removed the cover image`,
  flaggedInProgressTooLong: (days) => icu($localize`:Notification line after the system name Kanera - the card has been in progress past the workspace alert:{days, plural, one {flagged this card as in progress for more than # day} other {flagged this card as in progress for more than # days}}`, { days }),
  flaggedSchedulingConflict: $localize`:Notification line after the system name Kanera - the card's planned start is before the planned finish of a card blocking it; that card's key follows:flagged that this card is planned to start before its blocker finishes`,
  correctedTimeInProgress: $localize`:Activity line after a person's name - a workspace admin changed a card's tracked time in progress:corrected the time in progress`,
  addedChecklist: $localize`:Notification line after a person's name; the checklist name follows:added checklist`,
  deletedChecklist: $localize`:Notification line after a person's name; the checklist name follows:deleted checklist`,
  completedSubChecklist: $localize`:Notification line after a person's name; the checklist name follows:completed sub-checklist`,
  subChecklistOn: (title, parentItem) => title
    ? $localize`:Sub-checklist title and the checklist item it belongs to:${title}:title: on ${parentItem}:item:`
    : $localize`:The checklist item a sub-checklist belongs to:on ${parentItem}:item:`,
  completedChecklist: $localize`:Notification line after a person's name; the checklist name follows:completed checklist`,
  renamedChecklistTo: $localize`:Notification line after a person's name; the new name follows:renamed checklist to`,
  editedChecklistItem: $localize`:Notification line after a person's name; the item text follows:edited checklist item`,
  updatedChecklistItemDescription: $localize`:Notification line after a person's name:updated a checklist item description`,
  clearedChecklistItemDescription: $localize`:Notification line after a person's name:cleared a checklist item description`,
  changedChecklistItemAssignee: (from, to) => $localize`:Notification line after a person's name:changed assignee from ${from}:previous: to ${to}:next:`,
  assignedChecklistItem: (name) => $localize`:Notification line after a person's name:assigned ${name}:person: to checklist item`,
  unassignedChecklistItem: $localize`:Notification line after a person's name:unassigned checklist item`,
  completedChecklistItem: $localize`:Notification line after a person's name; the item text follows:completed checklist item`,
  uncompletedChecklistItem: $localize`:Notification line after a person's name; the item text follows:marked checklist item incomplete`,
  addedChecklistItem: $localize`:Notification line after a person's name; the item text follows:added checklist item`,
  deletedChecklistItem: $localize`:Notification line after a person's name; the item text follows:deleted checklist item`,
  otherAction: (action) => $localize`:Notification line for an unrecognised change; an internal action name follows:made a change (${action}:action:)`,
  list: (names) => {
    listFormat ??= new Intl.ListFormat(appLocale(), { style: "long", type: "conjunction" });
    return listFormat.format(names);
  },
};
