import { z } from "zod";
import { WORKSPACE_KINDS } from "../schema/workspace.js";
import { storageUsageResponse } from "./auth.js";
import { STORAGE_DELETE_MAX_FILES } from "./storage-limits.js";

/**
 * Organisation storage management (Settings → Organisation → Storage). Usage is the same org-wide
 * pool the upload gates enforce; the file list and bulk delete are an admin cleanup tool.
 */

export const STORAGE_FILE_KINDS = ["card", "note"] as const;
export type StorageFileKind = (typeof STORAGE_FILE_KINDS)[number];

export const STORAGE_FILE_SORTS = ["largest", "oldest"] as const;
export type StorageFileSort = (typeof STORAGE_FILE_SORTS)[number];

export const STORAGE_CATEGORY_KEYS = ["cards", "notes", "personal"] as const;
export type StorageCategoryKey = (typeof STORAGE_CATEGORY_KEYS)[number];

const storageTotals = z.object({
  bytes: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
});

export const storageOverviewResponse = z.object({
  usage: storageUsageResponse,
  warningPercent: z.number().int().min(1).max(100),
  // Personal notes and scratchpads are private to their owners, so they appear only as a total.
  categories: z.array(storageTotals.extend({ key: z.enum(STORAGE_CATEGORY_KEYS) })),
  workspaces: z.array(storageTotals.extend({
    workspaceId: z.uuid(),
    name: z.string(),
    kind: z.enum(WORKSPACE_KINDS),
  })),
});
export type StorageOverviewResponse = z.infer<typeof storageOverviewResponse>;

// Query strings carry booleans as text; z.coerce.boolean() would read "false" as true.
const queryFlag = z.enum(["true", "false"]).transform((value) => value === "true");

export const storageFilesQuery = z.object({
  kind: z.enum(["all", ...STORAGE_FILE_KINDS]).default("all"),
  sort: z.enum(STORAGE_FILE_SORTS).default("largest"),
  minBytes: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  olderThanDays: z.coerce.number().int().min(1).max(3650).optional(),
  archivedOnly: queryFlag.optional(),
  workspaceId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
export type StorageFilesQuery = z.input<typeof storageFilesQuery>;

export const storageFileRow = z.object({
  kind: z.enum(STORAGE_FILE_KINDS),
  id: z.uuid(),
  fileName: z.string(),
  mimeType: z.string(),
  byteSize: z.number().int().nonnegative(),
  createdAt: z.string(),
  uploadedByName: z.string(),
  workspaceId: z.uuid(),
  workspaceName: z.string(),
  workspaceKind: z.enum(WORKSPACE_KINDS),
  boardId: z.uuid().nullable(),
  boardName: z.string().nullable(),
  cardId: z.uuid().nullable(),
  cardKey: z.string().nullable(),
  organisationKey: z.string().nullable(),
  cardTitle: z.string().nullable(),
  noteId: z.uuid().nullable(),
  noteTitle: z.string().nullable(),
  // The card or its board is archived: the file is out of sight but still counts against the quota.
  archived: z.boolean(),
});
export type StorageFileRow = z.infer<typeof storageFileRow>;

export const storageFilesResponse = z.object({
  items: z.array(storageFileRow),
  // Totals cover every file matching the filters, not only this page, so the UI can say how much a
  // cleanup would free before the admin pages through it.
  total: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
});
export type StorageFilesResponse = z.infer<typeof storageFilesResponse>;

export const deleteStorageFilesBody = z.object({
  files: z.array(z.object({
    kind: z.enum(STORAGE_FILE_KINDS),
    id: z.uuid(),
  })).min(1).max(STORAGE_DELETE_MAX_FILES),
});
export type DeleteStorageFilesBody = z.infer<typeof deleteStorageFilesBody>;

export const deleteStorageFilesResponse = z.object({
  deletedCount: z.number().int().nonnegative(),
  freedBytes: z.number().int().nonnegative(),
});
export type DeleteStorageFilesResponse = z.infer<typeof deleteStorageFilesResponse>;
