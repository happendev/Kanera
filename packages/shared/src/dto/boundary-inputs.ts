import { offsetTimestamp, calendarDate } from "./_dates.js";
import { z } from "zod";
import { ATTACHMENT_SOURCES } from "../schema/card-attachment.js";
import { NOTE_ATTACHMENT_SOURCES } from "../schema/note-attachment.js";
import { reactionTypeSchema } from "./comment-reactions.js";
import { ianaTimeZoneName } from "./_time-zone.js";
import { uuidParams } from "./route-params.js";

const queryBoolean = z.enum(["true", "false"]);
const queryInteger = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
export const boardReadQuery = z.object({ includeCards: queryBoolean.optional() });
export const boardOpenQuery = boardReadQuery.extend({
  includeCompleted: queryBoolean.optional(),
  archived: queryBoolean.optional(),
  completedFrom: z.union([calendarDate, offsetTimestamp]).optional(),
  completedTo: z.union([calendarDate, offsetTimestamp]).optional(),
  listId: z.uuid().optional(),
  cardLimit: queryInteger.pipe(z.number().min(1).max(100)).optional(),
  cardOffset: queryInteger.default(0),
});
export const boardTransferQuery = z.object({ crossWorkspace: z.enum(["0", "1", "true", "false"]).optional() });
export const attachmentUploadQuery = z.object({ source: z.enum(ATTACHMENT_SOURCES).optional(), commentId: z.uuid().optional() });
export const noteAttachmentUploadQuery = z.object({ source: z.enum(NOTE_ATTACHMENT_SOURCES).optional() });
export const setCardCoverBody = z.object({ attachmentId: z.uuid().nullable() });
export const reactionParams = uuidParams("id").extend({ type: reactionTypeSchema });
export const adminUserScopeQuery = z.object({ clientId: z.uuid().optional() });
export const serviceConnectionParams = uuidParams("workspaceId").extend({ clientId: z.string().regex(/^kanera_service_[A-Za-z0-9_-]{24}$/) });
export const mediaParams = uuidParams("clientId").extend({ "*": z.string().min(1).max(4096) });
export const signedMediaQuery = z.object({
  t: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
  e: z.string().regex(/^\d+$/),
  s: z.enum(["session", "share"]).optional(),
  fn: z.string().max(1024).optional(),
});
export const resignMediaQuery = z.object({ u: z.string().min(1).max(8192) });
export const activityQuery = z.object({ limit: queryInteger.pipe(z.number().min(1).max(200)).default(50), cursor: z.string().min(1).max(2048).optional() });
export const activityCursor = z.object({ boardId: z.uuid(), createdAt: offsetTimestamp, priority: z.union([z.literal(0), z.literal(1)]), id: z.uuid() });
export const invitationLookupQuery = z.object({ token: z.string().min(1).max(512) });
export const completedCardsCursor = z.object({ completedAt: offsetTimestamp, id: z.uuid() });
export const workCardsCursor = z.object({ asOf: offsetTimestamp, seenIds: z.array(z.uuid()).max(10_000) });
export const agentHistoryCursor = z.object({
  kind: z.literal("agentWorkHistory"), signature: z.string().min(1).max(128),
  from: offsetTimestamp, to: offsetTimestamp,
  timeZone: ianaTimeZoneName, at: offsetTimestamp,
  // History merges ordinary activity UUIDs with synthetic checklist completion keys.
  id: z.union([z.uuid(), z.string().refine(value => value.startsWith("checklistItem:") && z.uuid().safeParse(value.slice("checklistItem:".length)).success)]),
});
