import { isSignal } from "@angular/core";
import type { CardDetailComponent } from "./card-detail.component";

// Keep the model and each section stable for the lifetime of an open drawer. Children read only
// their selected signals, so an unrelated editor/popover update cannot dirty a large collection.
// Actions remain bound to the coordinator; no child loads data or subscribes to realtime.
function sectionModel<K extends keyof CardDetailComponent>(parent: CardDetailComponent, keys: readonly K[]): Pick<CardDetailComponent, K> {
  return Object.fromEntries(keys.map((key) => {
    const value = parent[key];
    return [key, typeof value === "function" && !isSignal(value) ? value.bind(parent) : value];
  })) as Pick<CardDetailComponent, K>;
}

const headerKeys = [
  "actionsMenuPlacement", "copyBranchName", "copyCardKey", "copyCardLink", "copyToBoard",
  "duplicateCard", "moveToBoard", "moveToList", "moveToListPlacement", "saveTitle",
  "setArchived", "setCover", "toggleCompletion", "actionsMenuOpen", "archiving",
  "boardId", "boardSummary", "canArchive", "canArchiveRole", "canEdit",
  "canEditRole", "canMoveToBoard", "canToggle", "cancelTitle", "card",
  "completionTickedCardId", "copyToBoardOpen", "coverUrl", "currentList", "draftTitle",
  "duplicating", "editTitle", "editingTitle", "goToBoard", "isWatchingCard",
  "labels", "mode", "moveToBoardOpen", "moveToListAnchor", "moveToListOpen",
  "openCoverLightbox", "otherLists", "pendingReminder", "reminderLabel", "reminderPopoverOpen",
  "requestClose", "savingCompletion", "showCardKeys", "showCardWatchButton", "sourceLists",
  "toggleActionsMenu", "toggleCardWatcherPopover", "toggleCopyToBoard", "toggleLayoutMode", "toggleMoveToBoard",
  "toggleMoveToList", "toggleReminderPopover", "watcherPopoverOpen", "workspaceId",
] as const;
export type CardDetailHeaderModel = Pick<CardDetailComponent, typeof headerKeys[number]>;

const metadataKeys = [
  "createLabel", "setDueDate", "setStartDate", "toggleAssignee", "toggleLabel",
  "assignedLabels", "assignedMembers", "assigneeIds", "assigneeProfileActions", "boardSummary",
  "canCreateLabels", "canEdit", "canEditRole", "dueDateLocalDate", "cardLabelIds",
  "cardLabels", "currentList", "currentUserId", "dueDateDueSoon", "dueDateInputValue",
  "dueDateOverdue", "dueDatePickerOpen", "dueDateSlot", "dueDateText", "durationHint",
  "goToBoard", "hasDueDate", "hasStartDate", "labelPickerOpen", "labels",
  "memberPickerOpen", "members", "moveToListOpen", "startDateInputValue", "startDatePickerOpen",
  "startDateText", "timelineEnabled", "toggleDueDatePicker", "toggleLabelPicker", "toggleMemberPicker",
  "toggleMoveToList", "toggleStartDatePicker", "workspaceId",
] as const;
export type CardDetailMetadataModel = Pick<CardDetailComponent, typeof metadataKeys[number]>;

const descriptionKeys = [
  "onSaveDescription", "canEdit", "canEditRole", "cancelEditDescription", "cardId",
  "descriptionExpanded", "descriptionOverflows", "discardDescriptionDraft", "draftDescription", "editingDescription",
  "editorInitialValue", "imageLightbox", "labels", "linkRevision", "members",
  "mirrorStatus", "onDescriptionDraftChange", "onDescriptionViewerClick", "openInlineAttachment", "recoveredDescriptionDraft",
  "startEditDescription", "toggleDescriptionExpanded", "workspaceId",
] as const;
export type CardDetailDescriptionModel = Pick<CardDetailComponent, typeof descriptionKeys[number]>;

const fieldsKeys = [
  "clearCfField", "setCheckboxField", "setDateField", "setField", "setUrlField",
  "toggleSelectOption", "toggleUserValue", "canEdit", "canEditRole", "cfPickerFieldId",
  "currentUserId", "customFieldValuesByFieldId", "customFields", "formatFieldDate", "members",
  "optionIdsFor", "optionsForField", "selectedOptionsByFieldId", "selectedUsersByFieldId", "toggleCfPicker",
  "userIdsFor", "workspaceId",
] as const;
export type CardDetailFieldsModel = Pick<CardDetailComponent, typeof fieldsKeys[number]>;

const checklistsKeys = [
  "applyChecklistTemplate", "bulkSetChecklistItemAssignee", "bulkSetChecklistItemDueDate", "checklistItemActionsMenuPlacement", "createChecklist",
  "createChecklistItem", "deleteChecklist", "deleteChecklistItemFromMenu", "dropChecklist", "dropChecklistItem",
  "saveChecklistItem", "saveChecklistTitle", "setChecklistItemAssignee", "setChecklistItemDueDate", "toggleChecklistItem",
  "addingChecklist", "addingItemChecklistId", "applyingChecklistTemplates", "assigneeIds", "availableChecklistTemplates",
  "bulkChecklistAssigneePickerId", "bulkChecklistDueDatePickerId", "canEdit", "canEditRole", "cancelAddChecklist",
  "cancelAddItem", "cancelChecklistItem", "cancelChecklistTitle", "checklistDropListId", "checklistDropListIdsFor",
  "checklistItemActionsMenuId", "checklistItemAssigneePickerId", "checklistItemDueDatePickerId", "checklistItemPresentationById", "checklistProgressById",
  "checklistTemplatePickerOpen", "checklistTemplateQuery", "checklistTemplates", "currentUserId", "draftChecklistTitle",
  "draftItemText", "editingChecklistId", "editingItemId", "filteredChecklistTemplates", "hiddenChecklistItemCount",
  "hideCompletedChecklistItems", "isChecklistCollapsed", "isChecklistTemplateApplied", "labels", "members",
  "newChecklistParentItemId", "newChecklistTitle", "newItemText", "onChecklistDragEnded", "onChecklistDragMoved",
  "onChecklistDragStarted", "openChecklistItemDetail", "openChecklistItemDetailsFromMenu", "openChecklistItemId", "startAddChecklist",
  "startAddItem", "startEditChecklist", "startEditChecklistItemFromMenu", "subChecklistProgressByItemId", "tickedChecklistItemId",
  "toggleBulkChecklistAssigneePicker", "toggleBulkChecklistDueDatePicker", "toggleChecklistCollapsed", "toggleChecklistItemAssigneePicker", "toggleChecklistItemDueDatePicker",
  "toggleChecklistTemplatePicker", "toggleCompletedChecklistItems", "topLevelChecklists", "visibleChecklistItems", "workspaceId",
] as const;
export type CardDetailChecklistsModel = Pick<CardDetailComponent, typeof checklistsKeys[number]>;

const attachmentsKeys = [
  "acceptAttr", "confirmDeleteAttachment", "downloadAttachment", "onAttachmentSelected", "setCover",
  "attachmentDisplayById", "attachmentDragActive", "canEdit", "canEditRole", "coverAttachmentId",
  "labels", "openAttachmentAudio", "openAttachmentImage", "openAttachmentMarkdown", "openAttachmentPdf",
  "openAttachmentText", "openAttachmentVideo", "uploads", "visibleAttachments",
] as const;
export type CardDetailAttachmentsModel = Pick<CardDetailComponent, typeof attachmentsKeys[number]>;

export function createCardDetailViewModel(parent: CardDetailComponent) {
  return {
    header: sectionModel(parent, headerKeys),
    metadata: sectionModel(parent, metadataKeys),
    description: sectionModel(parent, descriptionKeys),
    fields: sectionModel(parent, fieldsKeys),
    checklists: sectionModel(parent, checklistsKeys),
    attachments: sectionModel(parent, attachmentsKeys),
  };
}
