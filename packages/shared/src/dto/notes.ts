import { z } from "zod";
import { colorTokenSchema } from "./_colors.js";
import { createIconSchema, DEFAULT_NOTE_ICON, updateIconSchema } from "./_icons.js";

export const noteScopeSchema = z.enum(["personal", "team"]);
export type NoteScopeValue = z.infer<typeof noteScopeSchema>;

export const createNoteBody = z.object({
  scope: noteScopeSchema,
  parentNoteId: z.uuid().nullable().optional(),
  title: z.string().max(200).optional(),
  icon: createIconSchema(DEFAULT_NOTE_ICON),
  color: colorTokenSchema.nullable().optional(),
});
export type CreateNoteBody = z.infer<typeof createNoteBody>;

export const updateNoteBody = z.object({
  title: z.string().max(200).optional(),
  content: z.string().optional(),
  icon: updateIconSchema(DEFAULT_NOTE_ICON),
  color: colorTokenSchema.nullable().optional(),
  baseUpdatedAt: z.iso.datetime().optional(),
});
export type UpdateNoteBody = z.infer<typeof updateNoteBody>;

export const moveNoteBody = z.object({
  parentNoteId: z.uuid().nullable(),
  afterNoteId: z.uuid().nullable().optional(),
  beforeNoteId: z.uuid().nullable().optional(),
});
export type MoveNoteBody = z.infer<typeof moveNoteBody>;

export const listNotesQuery = z.object({
  scope: noteScopeSchema,
});
export type ListNotesQuery = z.infer<typeof listNotesQuery>;
