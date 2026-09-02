import { z } from "zod";
import { CUSTOM_FIELD_TYPES } from "../schema/custom-field.js";
import { CSV_DATE_ORDERS, CSV_MULTI_VALUE_DELIMITERS, CSV_SINGLE_TARGETS } from "./csv-import-targets.js";
import { trelloImportManifest } from "./imports.js";
import { WORKSPACE_ENTITY_NAME_MAX_LENGTH } from "./name-limits.js";

export * from "./csv-import-targets.js";

export const MAX_CSV_IMPORT_BYTES = 20 * 1024 * 1024;
export const MAX_CSV_IMPORT_ROWS = 20_000;
export const MAX_CSV_IMPORT_COLUMNS = 200;
export const CSV_PREVIEW_ROWS = 20;

// Derived from the schema tuple so a renamed or added field type cannot drift; `user` is excluded
// because a CSV cell cannot reference a workspace member id.
export const csvCustomFieldTypeSchema = z.enum(CUSTOM_FIELD_TYPES).exclude(["user"]);
export type CsvCustomFieldType = z.infer<typeof csvCustomFieldTypeSchema>;

export const csvColumnTarget = z.discriminatedUnion("target", [
  z.object({ target: z.literal("title") }),
  z.object({ target: z.literal("description") }),
  z.object({ target: z.literal("list") }),
  z.object({ target: z.literal("labels") }),
  z.object({ target: z.literal("assignees") }),
  z.object({ target: z.literal("dueDate") }),
  z.object({ target: z.literal("completed") }),
  z.object({ target: z.literal("archived") }),
  z.object({ target: z.literal("createdAt") }),
  z.object({ target: z.literal("comment") }),
  z.object({ target: z.literal("checklistItem") }),
  z.object({ target: z.literal("cardId") }),
  z.object({ target: z.literal("ignore") }),
  z.object({
    target: z.literal("customField"),
    name: z.string().trim().min(1).max(WORKSPACE_ENTITY_NAME_MAX_LENGTH),
    type: csvCustomFieldTypeSchema,
  }),
]);
export type CsvColumnTarget = z.infer<typeof csvColumnTarget>;

export const csvColumnMapping = z.object({
  hasHeaderRow: z.boolean(),
  multiValueDelimiter: z.enum(CSV_MULTI_VALUE_DELIMITERS),
  dateOrder: z.enum(CSV_DATE_ORDERS),
  timezone: z.string().trim().min(1).max(64),
  columns: z.record(z.string().regex(/^\d+$/), csvColumnTarget),
}).superRefine((value, ctx) => {
  const targets = Object.values(value.columns);
  if (targets.filter((entry) => entry.target === "title").length !== 1) {
    ctx.addIssue({ code: "custom", message: "exactly one title column is required", path: ["columns"] });
  }
  for (const target of CSV_SINGLE_TARGETS) {
    if (targets.filter((entry) => entry.target === target).length > 1) {
      ctx.addIssue({ code: "custom", message: `only one ${target} column is allowed`, path: ["columns"] });
    }
  }
  const names = new Set<string>();
  for (const [index, entry] of Object.entries(value.columns)) {
    if (entry.target !== "customField") continue;
    const normalized = entry.name.trim().toLocaleLowerCase();
    if (names.has(normalized)) {
      ctx.addIssue({ code: "custom", message: "custom field names must be unique", path: ["columns", index, "name"] });
    }
    names.add(normalized);
  }
});
export type CsvColumnMapping = z.infer<typeof csvColumnMapping>;

export const csvImportIssues = z.object({
  rowsWithoutTitle: z.number().int().nonnegative(),
  unparseableDates: z.number().int().nonnegative(),
  unparseableNumbers: z.number().int().nonnegative(),
  invalidUrls: z.number().int().nonnegative(),
  ambiguousDateColumns: z.array(z.number().int().nonnegative()),
  raggedRows: z.number().int().nonnegative(),
});
export type CsvImportIssues = z.infer<typeof csvImportIssues>;

export const csvImportManifest = trelloImportManifest.extend({
  source: z.literal("csv"),
  counts: trelloImportManifest.shape.counts.extend({
    rows: z.number().int().nonnegative(),
    skippedRows: z.number().int().nonnegative(),
  }),
});
export type CsvImportManifest = z.infer<typeof csvImportManifest>;

export const csvImportPreview = z.object({
  columns: z.array(z.object({ index: z.number().int().nonnegative(), name: z.string(), samples: z.array(z.string()).max(3) })),
  firstRows: z.array(z.array(z.string())),
  rowCount: z.number().int().nonnegative(),
  delimiter: z.string(),
  encoding: z.string(),
  suggestedMapping: csvColumnMapping,
});
export type CsvImportPreview = z.infer<typeof csvImportPreview>;

export const analyzeCsvImportResponse = z.object({
  importId: z.uuid(),
  preview: csvImportPreview,
  manifest: csvImportManifest,
  issues: csvImportIssues,
});
export type AnalyzeCsvImportResponse = z.infer<typeof analyzeCsvImportResponse>;

export const csvColumnsResponse = z.object({ manifest: csvImportManifest, issues: csvImportIssues });
export type CsvColumnsResponse = z.infer<typeof csvColumnsResponse>;
