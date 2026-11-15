import { isoTimestamp, calendarDate } from "./_dates.js";
import { z } from "zod";
import { ianaTimeZoneName } from "./_time-zone.js";
import { reactionTypeSchema } from "./comment-reactions.js";
import { CARD_DUE_DATE_SLOTS } from "../lib/due-date-slots.js";
import { ATTACHMENT_SOURCES } from "../schema/card-attachment.js";
import { TRELLO_IMPORT_STATUSES } from "../schema/trello-import.js";
import { colorTokenSchema, gradientTokenSchema } from "./_colors.js";
import { customFieldTypeSchema, customFieldValueColumns } from "./custom-fields.js";
import {
  createIconSchema,
  DEFAULT_BOARD_ICON,
  DEFAULT_CUSTOM_FIELD_ICON,
  DEFAULT_LIST_ICON,
  iconTokenSchema,
} from "./_icons.js";
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

const dateLike = z.union([isoTimestamp, z.date()]);
const nullableDateLike = z.union([dateLike, z.null()]);
const archiveTimes = { createdAt: dateLike.optional(), updatedAt: dateLike.optional() };
// Checklist positions are restored verbatim into numeric(20,10); other positions only order imports.
const archivePosition = z.string().regex(/^-?\d{1,10}(?:\.\d{1,10})?$/);
const archiveDueDate = {
  dueDateLocalDate: calendarDate.nullable().optional(),
  dueDateSlot: z.enum(CARD_DUE_DATE_SLOTS).nullable().optional(),
  dueDateTimezone: ianaTimeZoneName.nullable().optional(),
};
// Shared by the archive and the manifest member rows. Older Kanera exports carry the retired
// owner/admin board roles; normalize them to editor so legacy archives still import under the
// editor/observer board-role model.
const kaneraImportMemberAccess = {
  source: z.enum(["workspace", "board"]),
  boardRole: z.enum(["owner", "admin", "editor", "observer"]).nullable().transform((r) => (r === "owner" || r === "admin" ? "editor" : r)),
};

export const kaneraBoardImportArchive = z.looseObject({
  format: z.literal("kanera.board.export"),
  version: z.literal(1),
  exportedAt: z.string(),
  board: z.looseObject({
    id: z.uuid(),
    workspaceId: z.uuid(),
    name: z.string(),
    description: z.string().max(2000).nullable().optional(),
    icon: iconTokenSchema.nullable().optional(),
    iconColor: colorTokenSchema.nullable().optional(),
    backgroundGradient: gradientTokenSchema.nullable().optional(),
  }),
  // `inProgress` is absent from exports made before in-progress lists existed.
  lists: z.array(z.looseObject({ id: z.uuid(), name: z.string(), position: archivePosition, inProgress: z.boolean().optional(), icon: iconTokenSchema.optional(), color: colorTokenSchema.nullable().optional(), archivedAt: nullableDateLike.optional() })),
  labels: z.array(z.looseObject({ id: z.uuid(), name: z.string(), color: colorTokenSchema.nullable().optional(), archivedAt: nullableDateLike.optional() })),
  customFields: z.array(z.looseObject({
    id: z.uuid(),
    name: z.string(),
    icon: iconTokenSchema.catch(DEFAULT_CUSTOM_FIELD_ICON),
    type: customFieldTypeSchema,
    allowMultiple: z.boolean().optional(),
    showOnCard: z.boolean().optional(),
    archivedAt: nullableDateLike.optional(),
    // Older archives omit option positions; supplied positions are persisted as numeric(20,10).
    options: z.array(z.looseObject({ id: z.uuid(), label: z.string(), color: colorTokenSchema.nullable().optional(), position: archivePosition.optional() })).default([]),
  })),
  members: z.array(z.looseObject({
    userId: z.uuid(),
    displayName: z.string(),
    email: z.email().optional(),
    ...kaneraImportMemberAccess,
  })),
  cards: z.array(z.looseObject({
    id: z.uuid(),
    listId: z.uuid(),
    title: z.string().min(1).max(500),
    description: z.string().max(50000).nullable().optional(),
    position: archivePosition,
    ...archiveDueDate,
    ...archiveTimes,
    startDateLocalDate: calendarDate.nullable().optional(),
    createdById: z.uuid().optional(),
    coverAttachmentId: z.uuid().nullable().optional(),
    completedAt: nullableDateLike.optional(),
    archivedAt: nullableDateLike.optional(),
    inProgressSince: nullableDateLike.optional(),
    inProgressSeconds: z.number().int().nonnegative().max(2147483647).optional(),
    listEnteredAt: nullableDateLike.optional(),
  })),
  cardAssignees: z.array(z.looseObject({ cardId: z.uuid(), userId: z.uuid() })),
  cardLabelAssignments: z.array(z.looseObject({ cardId: z.uuid(), labelId: z.uuid() })),
  cardCustomFieldValues: z.array(z.looseObject({ cardId: z.uuid(), fieldId: z.uuid(), ...customFieldValueColumns })),
  checklists: z.array(z.looseObject({
    id: z.uuid(),
    cardId: z.uuid(),
    title: z.string().min(1).max(500),
    position: archivePosition,
    parentItemId: z.uuid().nullable().default(null),
    ...archiveTimes,
    items: z.array(z.looseObject({
      id: z.uuid(), text: z.string().min(1).max(2000), position: archivePosition,
      description: z.string().max(50000).nullable().optional(),
      assigneeId: z.uuid().nullable().optional(),
      completedAt: nullableDateLike.optional(), completedById: z.uuid().nullable().optional(),
      ...archiveDueDate, ...archiveTimes,
    })),
  })),
  comments: z.array(z.looseObject({ id: z.uuid(), cardId: z.uuid(), authorId: z.uuid(), body: z.string(), authorName: z.string().nullable().optional(), editedAt: nullableDateLike.optional(), ...archiveTimes })),
  commentReactions: z.array(z.looseObject({ commentId: z.uuid(), userId: z.uuid(), reactionType: reactionTypeSchema })),
  cardWatchers: z.array(z.looseObject({ cardId: z.uuid(), userId: z.uuid() })),
  // The importer fetches/copies these, so the attacker-controllable parts must at least be
  // well-formed: an absolute URL plus string metadata. Scheme/host policy is enforced server-side.
  attachments: z.array(z.looseObject({
    id: z.uuid(),
    cardId: z.uuid(),
    url: z.url(),
    mimeType: z.string().min(1).max(255),
    fileName: z.string().min(1).max(1024),
    source: z.enum(ATTACHMENT_SOURCES).default("attachment"),
    uploadedById: z.uuid().optional(),
    commentId: z.uuid().nullable().optional(),
    createdAt: dateLike.optional(),
  })),
}).superRefine((archive, ctx) => {
  // IDs are remapping keys, so duplicates or cross-card checklist parents are ambiguous even
  // when every individual row is well typed. Reject before storing an executable import plan.
  const unique = (keys: string[], path: string) => {
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", path: [path], message: "duplicate import identifier" });
  };
  for (const key of ["lists", "labels", "customFields", "cards", "checklists", "comments", "attachments"] as const) unique(archive[key].map(row => row.id), key);
  unique(archive.customFields.flatMap(field => field.options.map(option => option.id)), "customFields");
  unique(archive.checklists.flatMap(checklist => checklist.items.map(item => item.id)), "checklists");
  unique(archive.cardCustomFieldValues.map(value => `${value.cardId}:${value.fieldId}`), "cardCustomFieldValues");
  const parentOwners = new Map(archive.checklists.flatMap(checklist => checklist.items.map(item => [item.id, checklist] as const)));
  archive.checklists.forEach((checklist, index) => {
    if (!checklist.parentItemId) return;
    const parent = parentOwners.get(checklist.parentItemId);
    if (parent && (parent.cardId !== checklist.cardId || parent.parentItemId)) {
      ctx.addIssue({ code: "custom", path: ["checklists", index, "parentItemId"], message: "invalid checklist parent" });
    }
  });
});
export type KaneraBoardImportArchive = z.infer<typeof kaneraBoardImportArchive>;

export const kaneraBoardImportManifest = trelloImportManifest.extend({
  source: z.literal("kanera"),
  board: trelloImportManifest.shape.board.extend({
    icon: iconTokenSchema.nullable().optional().catch(DEFAULT_BOARD_ICON),
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
    ...kaneraImportMemberAccess,
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
    icon: createIconSchema(DEFAULT_BOARD_ICON),
    iconColor: colorTokenSchema.nullable().optional(),
  }),
  lists: z.record(z.string(), createMapSkip({
    name: z.string().trim().min(1).max(WORKSPACE_ENTITY_NAME_MAX_LENGTH).optional(),
    icon: createIconSchema(DEFAULT_LIST_ICON),
    color: colorTokenSchema.nullable().optional(),
  })),
  labels: z.record(z.string(), createMapSkip({
    name: z.string().trim().min(1).max(CARD_LABEL_NAME_MAX_LENGTH).optional(),
    color: colorTokenSchema.nullable().optional(),
  })),
  customFields: z.record(z.string(), createMapSkip({
    name: z.string().trim().min(1).max(WORKSPACE_ENTITY_NAME_MAX_LENGTH).optional(),
    type: customFieldTypeSchema.optional(),
    icon: createIconSchema(DEFAULT_CUSTOM_FIELD_ICON),
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
  status: z.enum(TRELLO_IMPORT_STATUSES),
  error: z.string().nullable(),
  progress: importAttachmentProgress.nullable(),
  result: importResultSummary.nullable(),
});
export type TrelloImportStatusResponse = z.infer<typeof trelloImportStatusResponse>;
