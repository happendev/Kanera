import { z } from "zod";
import { TABLER_ICONS } from "../tabler-icons.js";

export const DEFAULT_WORKSPACE_ICON = "rocket";
export const DEFAULT_BOARD_ICON = "layout-kanban";
export const DEFAULT_LIST_ICON = "list";
export const DEFAULT_NOTE_ICON = "file-text";
export const DEFAULT_CUSTOM_FIELD_ICON = "forms";

const tablerIconNames = new Set<string>(TABLER_ICONS);

/** Keep persisted icon slugs aligned with the exact Tabler webfont bundled by the client. */
export const iconTokenSchema = z.string().min(1).max(60).refine(
  (icon) => tablerIconNames.has(icon),
  "unknown Tabler icon",
);

export function createIconSchema(fallback: string) {
  return iconTokenSchema.nullable().optional().transform((icon) => icon ?? fallback);
}

export function updateIconSchema(fallback: string) {
  return iconTokenSchema.nullable().optional().transform((icon) => icon === null ? fallback : icon);
}
