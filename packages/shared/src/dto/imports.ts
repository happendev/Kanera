import { z } from "zod";
import { colorTokenSchema } from "./_colors.js";
import { customFieldTypeSchema } from "./custom-fields.js";
import { CARD_LABEL_NAME_MAX_LENGTH, WORKSPACE_ENTITY_NAME_MAX_LENGTH } from "./name-limits.js";

export const MAX_TRELLO_IMPORT_BYTES = 50 * 1024 * 1024;
export const MAX_KANERA_BOARD_IMPORT_BYTES = 50 * 1024 * 1024;

export const trelloImportManifest = z.object({
  board: z.object({
    name: z.string(),
    desc: z.string().nullable(),
  }),
  lists: z.array(z.object({
    id: z.string(),
    name: z.string(),
    closed: z.boolean(),
    cardCount: z.number().int().nonnegative(),
  })),
  labels: z.array(z.object({
    id: z.string(),
    name: z.string(),
    trelloColor: z.string().nullable(),
    suggestedToken: colorTokenSchema,
  })),
  customFields: z.array(z.object({
    id: z.string(),
    name: z.string(),
    trelloType: z.string(),
    suggestedType: customFieldTypeSchema,
    options: z.array(z.object({
      id: z.string(),
      label: z.string(),
      color: colorTokenSchema.nullable(),
    })).optional(),
  })),
  members: z.array(z.object({
    id: z.string(),
    fullName: z.string(),
    username: z.string().nullable(),
    email: z.email().nullable().optional(),
  })),
  counts: z.object({
    cards: z.number().int().nonnegative(),
    checklists: z.number().int().nonnegative(),
    comments: z.number().int().nonnegative(),
    linkAttachments: z.number().int().nonnegative(),
    uploadedAttachments: z.number().int().nonnegative(),
  }),
});
export type TrelloImportManifest = z.infer<typeof trelloImportManifest>;

export const analyzeImportResponse = z.object({
  importId: z.uuid(),
  manifest: trelloImportManifest,
});
export type AnalyzeImportResponse = z.infer<typeof analyzeImportResponse>;

const dateLike = z.union([z.iso.datetime(), z.date()]);
const nullableDateLike = z.union([dateLike, z.null()]);
const kaneraBoardArchiveEntity = z.looseObject({ id: z.uuid() });

export const kaneraBoardImportArchive = z.looseObject({
  format: z.literal("kanera.board.export"),
  version: z.literal(1),
  exportedAt: z.string(),
  board: z.looseObject({
    id: z.uuid(),
    workspaceId: z.uuid(),
    name: z.string(),
    description: z.string().nullable().optional(),
  }),
  lists: z.array(z.looseObject({ id: z.uuid(), name: z.string(), position: z.string() })),
  labels: z.array(z.looseObject({ id: z.uuid(), name: z.string(), color: colorTokenSchema.nullable().optional() })),
  customFields: z.array(z.looseObject({
    id: z.uuid(),
    name: z.string(),
    icon: z.string(),
    type: customFieldTypeSchema,
    allowMultiple: z.boolean().optional(),
    options: z.array(z.looseObject({ id: z.uuid(), label: z.string(), color: colorTokenSchema.nullable().optional() })).optional(),
  })),
  members: z.array(z.looseObject({
    userId: z.uuid(),
    displayName: z.string(),
    email: z.email().optional(),
    source: z.enum(["workspace", "board"]),
    // Older Kanera exports carry the retired owner/admin board roles; normalize them to editor so
    // legacy archives still import under the editor/observer board-role model.
    boardRole: z.enum(["owner", "admin", "editor", "observer"]).nullable().transform((r) => (r === "owner" || r === "admin" ? "editor" : r)),
  })),
  cards: z.array(z.looseObject({
    id: z.uuid(),
    listId: z.uuid(),
    title: z.string(),
    position: z.string(),
    completedAt: nullableDateLike.optional(),
    archivedAt: nullableDateLike.optional(),
  })),
  cardAssignees: z.array(z.looseObject({ cardId: z.uuid(), userId: z.uuid() })),
  cardLabelAssignments: z.array(z.looseObject({ cardId: z.uuid(), labelId: z.uuid() })),
  cardCustomFieldValues: z.array(z.looseObject({ cardId: z.uuid(), fieldId: z.uuid() })),
  checklists: z.array(z.looseObject({
    id: z.uuid(),
    cardId: z.uuid(),
    title: z.string(),
    items: z.array(z.looseObject({ id: z.uuid(), text: z.string(), position: z.string() })),
  })),
  comments: z.array(z.looseObject({ id: z.uuid(), cardId: z.uuid(), authorId: z.uuid(), body: z.string() })),
  commentReactions: z.array(z.looseObject({ commentId: z.uuid(), userId: z.uuid(), reactionType: z.string() })),
  cardWatchers: z.array(z.looseObject({ cardId: z.uuid(), userId: z.uuid() })),
  attachments: z.array(kaneraBoardArchiveEntity),
});
export type KaneraBoardImportArchive = z.infer<typeof kaneraBoardImportArchive>;

export const kaneraBoardImportManifest = trelloImportManifest.extend({
  source: z.literal("kanera"),
  board: trelloImportManifest.shape.board.extend({
    icon: z.string().nullable().optional(),
    iconColor: colorTokenSchema.nullable().optional(),
  }),
  lists: z.array(trelloImportManifest.shape.lists.element.extend({
    archivedAt: z.string().nullable(),
  })),
  labels: z.array(trelloImportManifest.shape.labels.element.extend({
    archivedAt: z.string().nullable(),
  })),
  customFields: z.array(trelloImportManifest.shape.customFields.element.extend({
    allowMultiple: z.boolean(),
    archivedAt: z.string().nullable(),
  })),
  members: z.array(trelloImportManifest.shape.members.element.extend({
    source: z.enum(["workspace", "board"]),
    // Older Kanera exports carry the retired owner/admin board roles; normalize them to editor so
    // legacy archives still import under the editor/observer board-role model.
    boardRole: z.enum(["owner", "admin", "editor", "observer"]).nullable().transform((r) => (r === "owner" || r === "admin" ? "editor" : r)),
  })),
});
export type KaneraBoardImportManifest = z.infer<typeof kaneraBoardImportManifest>;

export const analyzeKaneraBoardImportResponse = z.object({
  importId: z.uuid(),
  manifest: kaneraBoardImportManifest,
});
export type AnalyzeKaneraBoardImportResponse = z.infer<typeof analyzeKaneraBoardImportResponse>;

const createMapSkip = <T extends z.ZodRawShape>(extra: T) =>
  z.discriminatedUnion("action", [
    z.object({ action: z.literal("create"), ...extra }),
    z.object({ action: z.literal("map"), targetListId: z.uuid().optional(), targetLabelId: z.uuid().optional(), targetFieldId: z.uuid().optional() }),
    z.object({ action: z.literal("skip") }),
  ]);

export const commitImportBody = z.object({
  board: z.object({
    name: z.string().trim().min(1).max(WORKSPACE_ENTITY_NAME_MAX_LENGTH),
    icon: z.string().min(1).max(60).nullable().optional(),
    iconColor: colorTokenSchema.nullable().optional(),
  }),
  lists: z.record(z.string(), createMapSkip({
    name: z.string().trim().min(1).max(WORKSPACE_ENTITY_NAME_MAX_LENGTH).optional(),
    icon: z.string().min(1).max(60).nullable().optional(),
    color: colorTokenSchema.nullable().optional(),
  })),
  labels: z.record(z.string(), createMapSkip({
    name: z.string().trim().min(1).max(CARD_LABEL_NAME_MAX_LENGTH).optional(),
    color: colorTokenSchema.nullable().optional(),
  })),
  customFields: z.record(z.string(), createMapSkip({
    name: z.string().trim().min(1).max(WORKSPACE_ENTITY_NAME_MAX_LENGTH).optional(),
    type: customFieldTypeSchema.optional(),
    icon: z.string().min(1).max(60).optional(),
  })),
  members: z.record(z.string(), z.uuid().nullable()),
  options: z.object({
    includeArchived: z.boolean().default(false),
    importComments: z.boolean().default(true),
    importCustomFields: z.boolean().default(true),
    attachmentCopyMode: z.enum(["copy", "skip"]).default("copy"),
  }),
}).superRefine((value, ctx) => {
  for (const [id, mapping] of Object.entries(value.lists)) {
    if (mapping.action === "map" && !mapping.targetListId) {
      ctx.addIssue({ code: "custom", message: "targetListId is required", path: ["lists", id, "targetListId"], input: mapping });
    }
  }
  for (const [id, mapping] of Object.entries(value.labels)) {
    if (mapping.action === "map" && !mapping.targetLabelId) {
      ctx.addIssue({ code: "custom", message: "targetLabelId is required", path: ["labels", id, "targetLabelId"], input: mapping });
    }
  }
  for (const [id, mapping] of Object.entries(value.customFields)) {
    if (mapping.action === "map" && !mapping.targetFieldId) {
      ctx.addIssue({ code: "custom", message: "targetFieldId is required", path: ["customFields", id, "targetFieldId"], input: mapping });
    }
  }
});
export type CommitImportBody = z.infer<typeof commitImportBody>;

const importCountSummary = z.object({
  created: z.number().int().nonnegative(),
  reused: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});

export const importResultSummary = z.object({
  createdBoardId: z.uuid(),
  lists: importCountSummary,
  labels: importCountSummary,
  customFields: importCountSummary,
  cards: z.object({ created: z.number().int().nonnegative(), archived: z.number().int().nonnegative() }),
  checklists: z.number().int().nonnegative(),
  checklistItems: z.number().int().nonnegative(),
  comments: z.number().int().nonnegative(),
  attachments: z.object({
    imported: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  }),
  warnings: z.array(z.string()),
});
export type ImportResultSummary = z.infer<typeof importResultSummary>;

export const importAttachmentProgress = z.object({
  phase: z.enum(["attachments", "finalizing"]),
  total: z.number().int().nonnegative(),
  processed: z.number().int().nonnegative(),
  imported: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});
export type ImportAttachmentProgress = z.infer<typeof importAttachmentProgress>;

export const trelloImportStatusResponse = z.object({
  status: z.enum(["analyzed", "ready", "importing", "completed", "failed"]),
  error: z.string().nullable(),
  progress: importAttachmentProgress.nullable(),
  result: importResultSummary.nullable(),
});
export type TrelloImportStatusResponse = z.infer<typeof trelloImportStatusResponse>;
