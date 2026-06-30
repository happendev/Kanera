import type { GradientToken } from "@kanera/shared/colors";
import { GRADIENT_TOKENS } from "@kanera/shared/colors";
import { viewPreferenceKey } from "../../../core/browser/browser-contracts";
import type { AggregateConfig, AggregateMetric, ColumnVisibility, GroupBy, SortBy } from "./list-view.types";

export type ViewMode = "board" | "list" | "notes" | "calendar" | "history";
export type ColumnWidths = Record<string, number>;
export type CompletedFilter = { from: string; to: string };

export function readCompletedFilter(scope: string): CompletedFilter | null {
  const raw = readString(viewPreferenceKey("completed", scope));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CompletedFilter>;
    const from = typeof parsed?.from === "string" ? parsed.from : "";
    const to = typeof parsed?.to === "string" ? parsed.to : "";
    return from || to ? { from, to } : null;
  } catch {
    return null;
  }
}

export function writeCompletedFilter(scope: string, value: CompletedFilter | null): void {
  const key = viewPreferenceKey("completed", scope);
  if (!value?.from && !value?.to) removeString(key);
  else writeString(key, JSON.stringify(value));
}

/** Whether the active view is the board or list — keyed by scope. */
export function readViewMode(scope: string): ViewMode | null {
  return readString(viewPreferenceKey("mode", scope)) as ViewMode | null;
}

export function writeViewMode(scope: string, mode: ViewMode): void {
  writeString(viewPreferenceKey("mode", scope), mode);
}

export function readViewBackground(scope: string): GradientToken | null {
  const value = readString(viewPreferenceKey("background", scope));
  return GRADIENT_TOKENS.includes(value as GradientToken) ? value as GradientToken : null;
}

export function writeViewBackground(scope: string, value: GradientToken | null): void {
  const key = viewPreferenceKey("background", scope);
  if (value === null) removeString(key);
  else writeString(key, value);
}

/** Group-by axis selected for the list view in this scope. */
export function readGroupBy(scope: string): GroupBy | null {
  return readString(viewPreferenceKey("groupBy", scope)) as GroupBy | null;
}

export function writeGroupBy(scope: string, value: GroupBy): void {
  writeString(viewPreferenceKey("groupBy", scope), value);
}

export function readSortBy(scope: string): SortBy | null {
  return readString(viewPreferenceKey("sort", scope)) as SortBy | null;
}

export function writeSortBy(scope: string, value: SortBy): void {
  writeString(viewPreferenceKey("sort", scope), value);
}

export function readShowSeparators(scope: string): boolean | null {
  const value = readString(viewPreferenceKey("showSeparators", scope));
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

export function writeShowSeparators(scope: string, value: boolean): void {
  writeString(viewPreferenceKey("showSeparators", scope), value ? "true" : "false");
}

export function readAggregateConfig(scope: string): AggregateConfig | null {
  const raw = readString(viewPreferenceKey("aggregates", scope));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const config: AggregateConfig = {};
    for (const [fieldId, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) continue;
      const metrics = value.filter(isAggregateMetric);
      if (metrics.length) config[fieldId] = [...new Set(metrics)];
    }
    return config;
  } catch {
    // Discard malformed JSON; fall back to no aggregates.
  }
  return null;
}

export function writeAggregateConfig(scope: string, value: AggregateConfig): void {
  writeString(viewPreferenceKey("aggregates", scope), JSON.stringify(value));
}

export function readColumnVisibility(scope: string): ColumnVisibility | null {
  const raw = readString(viewPreferenceKey("columns", scope));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") return parsed as ColumnVisibility;
  } catch {
    // Discard malformed JSON; fall back to default visibility.
  }
  return null;
}

export function writeColumnVisibility(scope: string, value: ColumnVisibility): void {
  writeString(viewPreferenceKey("columns", scope), JSON.stringify(value));
}

export function readColumnOrder(scope: string): string[] | null {
  const raw = readString(viewPreferenceKey("columnOrder", scope));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((value) => typeof value === "string")) return parsed;
  } catch {
    // Discard malformed JSON; fall back to default order.
  }
  return null;
}

export function writeColumnOrder(scope: string, value: string[]): void {
  writeString(viewPreferenceKey("columnOrder", scope), JSON.stringify(value));
}

export function readColumnWidths(scope: string): ColumnWidths | null {
  const raw = readString(viewPreferenceKey("columnWidths", scope));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const widths: ColumnWidths = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value)) widths[key] = value;
    }
    return widths;
  } catch {
    // Discard malformed JSON; fall back to default widths.
  }
  return null;
}

export function writeColumnWidths(scope: string, value: ColumnWidths): void {
  writeString(viewPreferenceKey("columnWidths", scope), JSON.stringify(value));
}

function readString(key: string): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeString(key: string, value: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore — quota or privacy mode
  }
}

function removeString(key: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore — quota or privacy mode
  }
}

function isAggregateMetric(value: unknown): value is AggregateMetric {
  return value === "sum" || value === "avg";
}
