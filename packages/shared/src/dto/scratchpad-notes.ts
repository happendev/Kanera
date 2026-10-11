import { z } from "zod";
import type { ScratchpadNoteAttachment } from "../schema/scratchpad-note-attachment.js";

export const createScratchpadNoteBody = z.object({
  title: z.string().max(200).optional(),
  content: z.string().max(50000).optional(),
});
export type CreateScratchpadNoteBody = z.infer<typeof createScratchpadNoteBody>;

/**
 * The web client never sends `baseUpdatedAt`. The scratchpad is last-write-wins for it by design: it
 * is one person's private page, autosaved on a debounce, so a 409-on-stale round trip would only
 * interrupt the owner with a conflict against themselves (usually their own in-flight save from
 * another tab). The client uses the returned `updatedAt` as its echo watermark instead. An agent
 * replacing a page it read earlier is a different writer, so the public API lets it opt in to the
 * staleness check rather than silently overwriting what the owner typed since.
 */
export const updateScratchpadNoteBody = z.object({
  title: z.string().max(200).optional(),
  content: z.string().optional(),
  baseUpdatedAt: z.iso.datetime().optional(),
}).refine(
  (value) => value.title !== undefined || value.content !== undefined,
  "provide at least one scratchpad note field to update",
);
export type UpdateScratchpadNoteBody = z.infer<typeof updateScratchpadNoteBody>;

// Anchor shape matches moveNoteBody: exactly one neighbour id, or an explicit null to mean
// "first"/"last". The scratchpad list is flat, so there is no parent to re-key.
export const moveScratchpadNoteBody = z.object({
  afterNoteId: z.uuid().nullable().optional(),
  beforeNoteId: z.uuid().nullable().optional(),
});
export type MoveScratchpadNoteBody = z.infer<typeof moveScratchpadNoteBody>;

// No uploader attribution: the owner is the only person who can upload to or read their scratchpad.
export type ScratchpadNoteAttachmentRow = Pick<
  ScratchpadNoteAttachment,
  "id" | "scratchpadNoteId" | "fileName" | "mimeType" | "byteSize" | "url" | "createdAt"
>;

/** Quick capture: append one open task to a named page, creating the page when it is missing. */
export const captureScratchpadItemBody = z.object({
  text: z.string().trim().min(1).max(2000),
  pageTitle: z.string().trim().min(1).max(200).default("Inbox"),
});
export type CaptureScratchpadItemBody = z.infer<typeof captureScratchpadItemBody>;
