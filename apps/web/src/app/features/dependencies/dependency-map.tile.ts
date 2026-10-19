import type { WireCardSummary, WireCustomField } from "@kanera/shared/events";
import type { CardCustomFieldValue } from "@kanera/shared/schema";
import { appLocale } from "../../core/i18n/locale";
import { formatDate } from "../../shared/date-format";
import type { CardLabelPresentation } from "../board/card-labels.component";
import { TILE_HEIGHT } from "./dependency-map.layout";

/**
 * What a Dependencies tile shows beyond its key and title, and how tall that makes it. Detailed
 * tiles carry what a board card carries (labels and the workspace's card-face fields); slim tiles
 * drop to key and title so a big map fits on screen.
 *
 * Heights are computed from the content rather than measured, like the rest of the map's geometry,
 * so connectors and chain boxes are right on the first frame. Every row below has a fixed height in
 * the stylesheet; change the two together.
 */

export type TileDensity = "detailed" | "slim";

export interface TileField {
  id: string;
  icon: string;
  name: string;
  /** The value as text; null for a checked checkbox, whose name is the value. */
  text: string | null;
  /** Select fields show their options as chips instead of text. */
  chips: { id: string; label: string; color: string | null }[];
  /** People fields show a count with a person icon, as board cards do. */
  people: boolean;
}

export interface TileContent {
  labels: CardLabelPresentation[];
  /** Every card-face field with a value, in workspace order. */
  fields: TileField[];
}

export const SLIM_TILE_HEIGHT = 56;
/** The label row (18px) and the gap above it. */
const LABEL_ROW = 22;
/** One field line (16px) and the gap between lines. */
const FIELD_LINE = 18;
const MAX_FIELD_LINES = 3;

export function tileContent(
  card: WireCardSummary,
  labelsById: ReadonlyMap<string, CardLabelPresentation>,
  fieldsByWorkspace: ReadonlyMap<string, readonly WireCustomField[]>,
): TileContent {
  const labels = card.labelIds.map((id) => labelsById.get(id)).filter((label) => label !== undefined);
  const values = new Map(card.customFieldValues.map((value) => [value.fieldId, value]));
  const fields: TileField[] = [];
  for (const field of fieldsByWorkspace.get(card.workspaceId) ?? []) {
    const value = values.get(field.id);
    const shown = value ? fieldFace(field, value) : null;
    if (shown) fields.push(shown);
  }
  return { labels, fields };
}

/** The fields a map tile has room for, and how many more it summarises on its last line. */
export function tileFields(content: TileContent): { fields: TileField[]; more: number } {
  if (content.fields.length <= MAX_FIELD_LINES) return { fields: content.fields, more: 0 };
  return { fields: content.fields.slice(0, MAX_FIELD_LINES - 1), more: content.fields.length - (MAX_FIELD_LINES - 1) };
}

export function tileHeight(content: TileContent, density: TileDensity): number {
  if (density === "slim") return SLIM_TILE_HEIGHT;
  const lines = Math.min(content.fields.length, MAX_FIELD_LINES);
  return TILE_HEIGHT + (content.labels.length ? LABEL_ROW : 0) + (lines ? 2 + lines * FIELD_LINE : 0);
}

/** A field's card-face value, or null when it has nothing worth showing (as on board cards). */
function fieldFace(field: WireCustomField, value: CardCustomFieldValue): TileField | null {
  const face = { id: field.id, icon: field.icon, name: field.name, text: null, chips: [], people: false };
  switch (field.type) {
    case "checkbox":
      return value.valueCheckbox ? face : null;
    case "select": {
      const chips = (value.valueOptionIds ?? [])
        .map((id) => field.options.find((option) => option.id === id))
        .filter((option) => option !== undefined)
        .map((option) => ({ id: option.id, label: option.label, color: option.color ?? null }));
      return chips.length ? { ...face, chips } : null;
    }
    case "user":
      return value.valueUserIds?.length ? { ...face, text: String(value.valueUserIds.length), people: true } : null;
    case "date":
      return value.valueDate ? { ...face, text: formatDate(value.valueDate, "short") || value.valueDate } : null;
    case "number": {
      const number = Number(value.valueNumber);
      if (value.valueNumber === null || value.valueNumber === "") return null;
      return { ...face, text: Number.isFinite(number) ? new Intl.NumberFormat(appLocale(), { maximumFractionDigits: 20 }).format(number) : value.valueNumber };
    }
    case "url":
      // A tile is a link to its card, so the address shows as text rather than a nested link.
      return value.valueUrl?.trim() ? { ...face, text: hostOf(value.valueUrl.trim()) } : null;
    default:
      return value.valueText?.trim() ? { ...face, text: value.valueText.trim() } : null;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}
