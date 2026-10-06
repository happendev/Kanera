import { z } from "zod";
import { CARD_TITLE_MAX_LENGTH } from "../card-value-limits.js";
import { CARD_DUE_DATE_SLOTS } from "../schema/card.js";
import { customFieldValueColumns } from "./custom-fields.js";
import { separatorAnchorItem } from "./separators.js";

export const dueDateSlot = z.enum(CARD_DUE_DATE_SLOTS);
export type DueDateSlot = z.infer<typeof dueDateSlot>;

export const createCardBody = z.object({
  title: z.string().min(1).max(CARD_TITLE_MAX_LENGTH),
  description: z.string().max(50000).optional(),
  atTop: z.boolean().optional(),
  // Typed lane anchors let a card be created directly between two existing lane items (the board's
  // hover "+" between cards) as one atomic create, instead of create-at-edge followed by a move.
  afterItem: separatorAnchorItem.nullable().optional(),
  beforeItem: separatorAnchorItem.nullable().optional(),
  // App-only: resolve the anchors inside one person's merged Global Work lane, where the visible
  // neighbours come from several boards and personal separators. Rejected by the public API.
  globalWorkUserId: z.uuid().optional(),
  assigneeIds: z.array(z.uuid()).optional(),
  clientToken: z.uuid().optional(),
}).refine(
  (v) => !(v.afterItem !== undefined && v.beforeItem !== undefined),
  "provide at most one of afterItem or beforeItem",
).refine(
  (v) => !(v.atTop !== undefined && (v.afterItem !== undefined || v.beforeItem !== undefined)),
  "use either atTop or a typed item anchor",
).refine(
  (v) => v.globalWorkUserId === undefined || v.afterItem !== undefined || v.beforeItem !== undefined,
  "globalWorkUserId requires a typed item anchor",
);
export type CreateCardBody = z.infer<typeof createCardBody>;

export const updateCardBody = z.object({
  title: z.string().min(1).max(CARD_TITLE_MAX_LENGTH).optional(),
  description: z.string().max(50000).nullable().optional(),
  dueDateLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  dueDateSlot: dueDateSlot.nullable().optional(),
}).refine(
  (value) => value.title !== undefined
    || value.description !== undefined
    || value.dueDateLocalDate !== undefined
    || value.dueDateSlot !== undefined,
  "provide at least one card field to update",
);
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
    globalWorkUserId: z.uuid().optional(),
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
// Unlike moveSeparatorBody, an after and a before anchor may be sent together: clients that know
// both neighbours of a drop send the adjacent pair, and the lane helper resolves it from the after
// side alone (its own next neighbour is that before anchor). The after side therefore takes
// precedence, so a non-adjacent pair positions by the after anchor and ignores the before one.
// Do not tighten this into one-anchor-only; the adjacent-pair form is part of the public contract.
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

// Checklist tree limits. Agents create whole plans in one request, so the bounds cover the tree,
// not just one array: a top-level checklist may carry up to 200 items, each item up to 20
// sub-checklists of up to 200 leaves, but one request may write at most 500 items in total.
export const CHECKLIST_ITEM_TEXT_MAX_LENGTH = 2000;
export const CHECKLIST_ITEMS_PER_REQUEST_MAX = 200;
export const CHECKLIST_SUB_CHECKLISTS_PER_ITEM_MAX = 20;
export const CHECKLIST_TREE_ITEMS_PER_REQUEST_MAX = 500;

const checklistTitle = z.string().trim().min(1).max(CARD_TITLE_MAX_LENGTH);
const checklistItemText = z.string().trim().min(1).max(CHECKLIST_ITEM_TEXT_MAX_LENGTH);
const checklistLocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// Sub-checklists are exactly one level deep and their items are leaves that carry only text and
// completion. The schemas below are strict on purpose: a description, assignee, due date, or
// further nesting on a leaf is rejected with its exact path instead of being silently dropped.
export const newSubChecklistItem = z.strictObject({
  text: checklistItemText,
  completed: z.boolean().optional(),
});
export type NewSubChecklistItem = z.infer<typeof newSubChecklistItem>;

export const newSubChecklist = z.strictObject({
  title: checklistTitle,
  items: z.array(newSubChecklistItem).max(CHECKLIST_ITEMS_PER_REQUEST_MAX).optional(),
});
export type NewSubChecklist = z.infer<typeof newSubChecklist>;

const newChecklistItemFields = {
  text: checklistItemText,
  description: z.string().max(50000).nullable().optional(),
  completed: z.boolean().optional(),
  assigneeId: z.uuid().nullable().optional(),
  dueDateLocalDate: checklistLocalDate.nullable().optional(),
  dueDateSlot: dueDateSlot.nullable().optional(),
  subChecklists: z.array(newSubChecklist).max(CHECKLIST_SUB_CHECKLISTS_PER_ITEM_MAX).optional(),
};

type NewItemShape = { dueDateLocalDate?: string | null; dueDateSlot?: string | null };
function refineNewItemDueDate(item: NewItemShape, ctx: z.RefinementCtx, path: (string | number)[] = []) {
  if (item.dueDateSlot != null && !item.dueDateLocalDate) {
    ctx.addIssue({ code: "custom", path: [...path, "dueDateSlot"], message: "provide dueDateLocalDate when setting dueDateSlot" });
  }
}

/** A fully specified top-level checklist item, optionally with its own one-level sub-checklists. */
export const newChecklistItem = z.strictObject(newChecklistItemFields).superRefine((item, ctx) => refineNewItemDueDate(item, ctx));
export type NewChecklistItem = z.infer<typeof newChecklistItem>;

type NewItemTree = { subChecklists?: { items?: unknown[] }[] }[];
function countTreeItems(items: NewItemTree | undefined): number {
  return (items ?? []).reduce((total, item) =>
    total + 1 + (item.subChecklists ?? []).reduce((sum, sub) => sum + (sub.items?.length ?? 0), 0), 0);
}

function refineTreeSize(items: NewItemTree | undefined, ctx: z.RefinementCtx, path: (string | number)[]) {
  const total = countTreeItems(items);
  if (total > CHECKLIST_TREE_ITEMS_PER_REQUEST_MAX) {
    ctx.addIssue({
      code: "custom",
      path,
      message: `one request may create at most ${CHECKLIST_TREE_ITEMS_PER_REQUEST_MAX} checklist items including sub-checklist items (received ${total})`,
    });
  }
}

// Creating a checklist may include its full contents. With parentItemId the new checklist is
// itself a sub-checklist, so its items must be leaves; that rule depends on a sibling field and is
// therefore checked in superRefine, reporting the first offending field by path.
export const createChecklistBody = z.strictObject({
  title: checklistTitle,
  parentItemId: z.uuid().nullable().optional(),
  items: z.array(z.strictObject(newChecklistItemFields)).max(CHECKLIST_ITEMS_PER_REQUEST_MAX).optional(),
}).superRefine((body, ctx) => {
  body.items?.forEach((item, index) => {
    refineNewItemDueDate(item, ctx, ["items", index]);
    if (!body.parentItemId) return;
    for (const field of ["description", "assigneeId", "dueDateLocalDate", "dueDateSlot", "subChecklists"] as const) {
      if (item[field] !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["items", index, field],
          message: `sub-checklist items support only text and completed; remove ${field}`,
        });
      }
    }
  });
  refineTreeSize(body.items, ctx, ["items"]);
});
export type CreateChecklistBody = z.infer<typeof createChecklistBody>;

export const listCardChecklistsQuery = z.strictObject({
  checklistId: z.uuid().optional(),
});
export type ListCardChecklistsQuery = z.infer<typeof listCardChecklistsQuery>;

export const applyChecklistTemplatesBody = z.object({
  templateIds: z.array(z.uuid()).min(1).max(100),
});
export type ApplyChecklistTemplatesBody = z.infer<typeof applyChecklistTemplatesBody>;

export const updateChecklistBody = z.object({
  title: z.string().trim().min(1).max(CARD_TITLE_MAX_LENGTH),
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

// Optional insertion anchor shared by single and batch item creation. Without one, new items are
// appended. A null id selects an edge: after null is the top, before null is the bottom.
const checklistItemAnchorFields = {
  afterItemId: z.uuid().nullable().optional(),
  beforeItemId: z.uuid().nullable().optional(),
};
type ItemAnchorShape = { afterItemId?: string | null; beforeItemId?: string | null };
function refineSingleAnchor(body: ItemAnchorShape, ctx: z.RefinementCtx) {
  if (body.afterItemId !== undefined && body.beforeItemId !== undefined) {
    ctx.addIssue({ code: "custom", path: ["beforeItemId"], message: "provide at most one of afterItemId or beforeItemId" });
  }
}

// `{ text }` remains the minimal valid body. Fields that only top-level items support are rejected
// by the route when the target checklist is a sub-checklist, with the offending field named.
export const createChecklistItemBody = z.strictObject({
  ...newChecklistItemFields,
  ...checklistItemAnchorFields,
}).superRefine((body, ctx) => {
  refineNewItemDueDate(body, ctx);
  refineSingleAnchor(body, ctx);
  refineTreeSize([body], ctx, ["subChecklists"]);
});
export type CreateChecklistItemBody = z.infer<typeof createChecklistItemBody>;

export const createChecklistItemsBody = z.strictObject({
  items: z.array(z.strictObject(newChecklistItemFields)).min(1).max(CHECKLIST_ITEMS_PER_REQUEST_MAX),
  ...checklistItemAnchorFields,
}).superRefine((body, ctx) => {
  body.items.forEach((item, index) => refineNewItemDueDate(item, ctx, ["items", index]));
  refineSingleAnchor(body, ctx);
  refineTreeSize(body.items, ctx, ["items"]);
});
export type CreateChecklistItemsBody = z.infer<typeof createChecklistItemsBody>;

export const bulkCreateChecklistItemsBody = z.object({
  items: z.array(z.object({
    cardId: z.uuid(),
    checklistId: z.uuid(),
    text: z.string().trim().min(1).max(2000),
    description: z.string().max(50000).nullable().optional(),
  })).min(1).max(200),
});
export type BulkCreateChecklistItemsBody = z.infer<typeof bulkCreateChecklistItemsBody>;

// Strict so a misspelled or unsupported field fails validation instead of being dropped while the
// rest of the change succeeds.
export const updateChecklistItemBody = z.strictObject({
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

// Selected-item updates address items on one card by id; the server derives each item's checklist
// and applies every change in one transaction, after validating the whole batch.
export const updateChecklistItemsBody = z.strictObject({
  updates: z.array(z.strictObject({
    itemId: z.uuid(),
    changes: updateChecklistItemBody,
  })).min(1).max(CHECKLIST_ITEMS_PER_REQUEST_MAX),
}).superRefine(({ updates }, ctx) => {
  const seen = new Set<string>();
  updates.forEach((update, index) => {
    if (seen.has(update.itemId)) {
      ctx.addIssue({ code: "custom", path: ["updates", index, "itemId"], message: "itemId must be unique within the batch; merge its changes into one entry" });
    }
    seen.add(update.itemId);
  });
});
export type UpdateChecklistItemsBody = z.infer<typeof updateChecklistItemsBody>;

// Strict: this applies to EVERY item in the checklist, so an unrecognised selector such as
// `itemIds` must be rejected rather than stripped into an update of the whole checklist.
export const bulkUpdateChecklistItemsBody = z.strictObject({
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
