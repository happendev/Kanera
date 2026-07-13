import { z } from "zod";
import { customFieldValueColumns } from "./custom-fields.js";
import { separatorAnchorItem } from "./separators.js";

export const dueDateSlot = z.enum(["anyTime", "morning", "afternoon", "endOfWorkDay"]);
export type DueDateSlot = z.infer<typeof dueDateSlot>;

export const createCardBody = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(50000).optional(),
  atTop: z.boolean().optional(),
  assigneeIds: z.array(z.uuid()).optional(),
  clientToken: z.uuid().optional(),
});
export type CreateCardBody = z.infer<typeof createCardBody>;

export const updateCardBody = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(50000).nullable().optional(),
  dueDateLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  dueDateSlot: dueDateSlot.nullable().optional(),
});
export type UpdateCardBody = z.infer<typeof updateCardBody>;

export const setCardCompletionBody = z.object({
  completed: z.boolean(),
});
export type SetCardCompletionBody = z.infer<typeof setCardCompletionBody>;

export const setCardArchivedBody = z.object({
  archived: z.boolean(),
});
export type SetCardArchivedBody = z.infer<typeof setCardArchivedBody>;

export const bulkCardSelectionBody = z.object({
  cardIds: z.array(z.uuid()).min(1).max(200),
});
export type BulkCardSelectionBody = z.infer<typeof bulkCardSelectionBody>;

// Read-only selected-card queries are not constrained by the mutation batch size. The API's
// normal request-body limit still bounds abusive payloads without imposing a product limit.
export const selectedCardQueryBody = z.object({
  cardIds: z.array(z.uuid()).min(1),
});
export type SelectedCardQueryBody = z.infer<typeof selectedCardQueryBody>;

// Model and integration workflows often need the rich checklist/comment content for a bounded
// selection without loading every attachment, member, and custom-field value in a board export.
export const selectedCardContentQueryBody = z.object({
  cardIds: z.array(z.uuid()).min(1).max(200),
});
export type SelectedCardContentQueryBody = z.infer<typeof selectedCardContentQueryBody>;

export const bulkSetCardCompletionBody = bulkCardSelectionBody.extend({
  completed: z.boolean(),
});
export type BulkSetCardCompletionBody = z.infer<typeof bulkSetCardCompletionBody>;

export const bulkSetCardDueDateBody = bulkCardSelectionBody.extend({
  dueDateLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  dueDateSlot: dueDateSlot.nullable().optional(),
});
export type BulkSetCardDueDateBody = z.infer<typeof bulkSetCardDueDateBody>;

export const bulkPatchCardLabelsBody = bulkCardSelectionBody.extend({
  mode: z.enum(["add", "remove"]),
  labelIds: z.array(z.uuid()).min(1),
});
export type BulkPatchCardLabelsBody = z.infer<typeof bulkPatchCardLabelsBody>;

export const bulkPatchCardAssigneesBody = bulkCardSelectionBody.extend({
  mode: z.enum(["add", "remove"]),
  userIds: z.array(z.uuid()).min(1),
});
export type BulkPatchCardAssigneesBody = z.infer<typeof bulkPatchCardAssigneesBody>;

export const bulkMoveCardsBody = bulkCardSelectionBody.extend({
  listId: z.uuid(),
});
export type BulkMoveCardsBody = z.infer<typeof bulkMoveCardsBody>;

export const bulkDuplicateCardsBody = bulkCardSelectionBody.extend({
  boardId: z.uuid().optional(),
  listId: z.uuid().optional(),
});
export type BulkDuplicateCardsBody = z.infer<typeof bulkDuplicateCardsBody>;

export const bulkArchiveCardsBody = bulkCardSelectionBody.extend({
  archived: z.literal(true),
});
export type BulkArchiveCardsBody = z.infer<typeof bulkArchiveCardsBody>;

// Bulk-set a single custom field's value across the selected cards.
// - setAll / fillEmpty / clear: scalar fields + single-value select/user.
//   fillEmpty only writes cards that currently have no value for the field.
// - add / remove: multi-value select/user (same tri-state semantics as bulk labels/assignees).
// The endpoint validates mode↔type compatibility and rejects mismatches.
export const bulkSetCardCustomFieldBody = bulkCardSelectionBody.extend({
  fieldId: z.uuid(),
  mode: z.enum(["setAll", "fillEmpty", "add", "remove", "clear"]),
  ...customFieldValueColumns,
});
export type BulkSetCardCustomFieldBody = z.infer<typeof bulkSetCardCustomFieldBody>;

export const moveCardBody = z
  .object({
    listId: z.uuid(),
    afterCardId: z.uuid().nullable().optional(),
    beforeCardId: z.uuid().nullable().optional(),
    afterItem: separatorAnchorItem.nullable().optional(),
    beforeItem: separatorAnchorItem.nullable().optional(),
  })
  .refine(
    (v) =>
      v.afterCardId !== undefined ||
      v.beforeCardId !== undefined ||
      v.afterItem !== undefined ||
      v.beforeItem !== undefined,
    "provide afterCardId, beforeCardId, afterItem, or beforeItem",
  )
  .refine(
    (v) => !(v.afterCardId !== undefined && v.afterItem !== undefined) && !(v.beforeCardId !== undefined && v.beforeItem !== undefined),
    "use either legacy card anchors or typed item anchors",
  );
export type MoveCardBody = z.infer<typeof moveCardBody>;

export const setCardAssigneesBody = z.object({
  userIds: z.array(z.uuid()),
});
export type SetCardAssigneesBody = z.infer<typeof setCardAssigneesBody>;

export const duplicateCardBody = z
  .object({
    boardId: z.uuid().optional(),
    listId: z.uuid().optional(),
    atTop: z.boolean().optional(),
  })
  .optional()
  .default({});
export type DuplicateCardBody = z.infer<typeof duplicateCardBody>;

export const moveCardToBoardBody = z.object({
  boardId: z.uuid(),
  listId: z.uuid().optional(),
});
export type MoveCardToBoardBody = z.infer<typeof moveCardToBoardBody>;

export const createChecklistBody = z.object({
  title: z.string().trim().min(1).max(500),
  parentItemId: z.uuid().nullable().optional(),
});
export type CreateChecklistBody = z.infer<typeof createChecklistBody>;

export const applyChecklistTemplatesBody = z.object({
  templateIds: z.array(z.uuid()).min(1).max(100),
});
export type ApplyChecklistTemplatesBody = z.infer<typeof applyChecklistTemplatesBody>;

export const updateChecklistBody = z.object({
  title: z.string().trim().min(1).max(500),
});
export type UpdateChecklistBody = z.infer<typeof updateChecklistBody>;

export const moveChecklistBody = z
  .object({
    afterChecklistId: z.uuid().nullable().optional(),
    beforeChecklistId: z.uuid().nullable().optional(),
  })
  .refine(
    (v) => v.afterChecklistId !== undefined || v.beforeChecklistId !== undefined,
    "provide afterChecklistId or beforeChecklistId",
  );
export type MoveChecklistBody = z.infer<typeof moveChecklistBody>;

export const createChecklistItemBody = z.object({
  text: z.string().trim().min(1).max(2000),
});
export type CreateChecklistItemBody = z.infer<typeof createChecklistItemBody>;

export const bulkCreateChecklistItemsBody = z.object({
  items: z.array(z.object({
    cardId: z.uuid(),
    checklistId: z.uuid(),
    text: z.string().trim().min(1).max(2000),
    description: z.string().max(50000).nullable().optional(),
  })).min(1).max(200),
});
export type BulkCreateChecklistItemsBody = z.infer<typeof bulkCreateChecklistItemsBody>;

export const updateChecklistItemBody = z.object({
  text: z.string().trim().min(1).max(2000).optional(),
  description: z.string().max(50000).nullable().optional(),
  completed: z.boolean().optional(),
  assigneeId: z.uuid().nullable().optional(),
  dueDateLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  dueDateSlot: dueDateSlot.nullable().optional(),
}).refine(
  (v) =>
    v.text !== undefined ||
    v.description !== undefined ||
    v.completed !== undefined ||
    v.assigneeId !== undefined ||
    v.dueDateLocalDate !== undefined ||
    v.dueDateSlot !== undefined,
  "provide text, description, completed, assigneeId, or dueDate",
);
export type UpdateChecklistItemBody = z.infer<typeof updateChecklistItemBody>;

export const bulkUpdateChecklistItemsBody = z.object({
  assigneeId: z.uuid().nullable().optional(),
  dueDateLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  dueDateSlot: dueDateSlot.nullable().optional(),
}).refine(
  (v) =>
    v.assigneeId !== undefined ||
    v.dueDateLocalDate !== undefined ||
    v.dueDateSlot !== undefined,
  "provide assigneeId or dueDate",
).refine(
  (v) => v.dueDateSlot === undefined || v.dueDateLocalDate !== undefined,
  "provide dueDateLocalDate when setting dueDateSlot",
);
export type BulkUpdateChecklistItemsBody = z.infer<typeof bulkUpdateChecklistItemsBody>;

export const bulkSetChecklistItemDescriptionsBody = z.object({
  updates: z.array(z.object({
    cardId: z.uuid(),
    checklistId: z.uuid(),
    itemId: z.uuid(),
    description: z.string().max(50000).nullable(),
  })).min(1).max(200),
}).superRefine(({ updates }, ctx) => {
  const itemIds = new Set<string>();
  updates.forEach((update, index) => {
    if (itemIds.has(update.itemId)) {
      ctx.addIssue({ code: "custom", path: ["updates", index, "itemId"], message: "itemId must be unique within the batch" });
    }
    itemIds.add(update.itemId);
  });
});
export type BulkSetChecklistItemDescriptionsBody = z.infer<typeof bulkSetChecklistItemDescriptionsBody>;

export const moveChecklistItemBody = z
  .object({
    checklistId: z.uuid().optional(),
    afterItemId: z.uuid().nullable().optional(),
    beforeItemId: z.uuid().nullable().optional(),
  })
  .refine(
    (v) => v.afterItemId !== undefined || v.beforeItemId !== undefined,
    "provide afterItemId or beforeItemId",
  );
export type MoveChecklistItemBody = z.infer<typeof moveChecklistItemBody>;
