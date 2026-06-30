import type { ColorToken } from "@kanera/shared/colors";
import type { CustomFieldTypeName } from "@kanera/shared/dto";

const COLOR_MAP: Record<string, ColorToken> = {
  black: "gray",
  blue: "blue",
  green: "green",
  lime: "lime",
  orange: "orange",
  pink: "pink",
  purple: "purple",
  red: "red",
  sky: "sky",
  yellow: "yellow",
};

const FIELD_TYPE_MAP: Record<string, CustomFieldTypeName> = {
  checkbox: "checkbox",
  date: "date",
  list: "select",
  number: "number",
  text: "text",
};

export function trelloColorToToken(color: string | null | undefined): ColorToken {
  if (!color) return "gray";
  const normalized = color.replace(/_(dark|light)$/u, "");
  return COLOR_MAP[normalized] ?? "gray";
}

export function trelloCustomFieldTypeToKanera(type: string | null | undefined): CustomFieldTypeName {
  return type ? FIELD_TYPE_MAP[type] ?? "text" : "text";
}
