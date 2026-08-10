import type { ColumnWidths } from "./view-preference";

export const ROW_INTERACTION_STOP_SELECTOR =
  ".lv-row-stop, .tv-row-stop, k-card-actions-menu, k-card-quick-edit, .cam-panel, .cqe-panel, .bp-panel, .dp-panel, .lp-panel, .mp-panel, .sp-panel, .qe-panel, .qe-popover";

export function builtinColumnLabel(id: string): string {
  switch (id) {
    case "title": return "Title";
    case "priority": return "Up next order";
    case "status": return "List";
    case "board": return "Board";
    case "assignees": return "Assignees";
    case "due": return "Due date";
    case "labels": return "Labels";
    case "checklist": return "Checklist";
    case "updated": return "Updated";
    case "created": return "Created";
    default: return id;
  }
}

export function builtinColumnIcon(id: string): string {
  switch (id) {
    case "title": return "forms";
    case "priority": return "list-numbers";
    case "status": return "list-details";
    case "board": return "layout-kanban";
    case "assignees": return "users";
    case "due": return "calendar-event";
    case "labels": return "tag";
    case "checklist": return "checkbox";
    case "updated": return "history";
    case "created": return "plus";
    default: return "minus";
  }
}

export function clampWidth(width: number, bounds: { min: number; max: number }): number {
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(width)));
}

export function gridTemplateFrom(
  ids: string[],
  widthFor: (id: string) => number,
  trailing: readonly number[] = [],
): string {
  return [...ids.map((id) => `${widthFor(id)}px`), ...trailing.map((width) => `${width}px`)].join(" ");
}

/**
 * Spend the sheet's leftover horizontal space on the columns instead of on the trailing filler track.
 *
 * Walked in visual order, so the leftmost column that can still use width gets it first and Title —
 * always first in the list — has first claim. Each column stops at its caller-supplied measured content
 * width, and whatever is still unspent once every value fits stays with the filler, which is what keeps
 * the row rules running to the right edge on a near-empty sheet.
 *
 * A column the viewer has sized by hand is skipped rather than grown: they have already said what
 * width they want it at, and quietly widening it back would read as the drag not having taken.
 *
 * Returns widths unchanged when there is no slack, so a sheet wider than its scrollport keeps its
 * natural width and scrolls exactly as before.
 */
export function distributeColumnSlack(options: {
  ids: readonly string[];
  available: number;
  baseFor: (id: string) => number;
  targetFor: (id: string) => number;
  isPinned?: (id: string) => boolean;
}): Record<string, number> {
  const { ids, available, baseFor, targetFor, isPinned } = options;
  const widths: Record<string, number> = {};
  let used = 0;
  for (const id of ids) {
    widths[id] = baseFor(id);
    used += widths[id]!;
  }

  let slack = Math.floor(available - used);
  if (!(slack > 0)) return widths;

  for (const id of ids) {
    if (slack <= 0) break;
    if (isPinned?.(id)) continue;
    const room = targetFor(id) - widths[id]!;
    if (room <= 0) continue;
    const grant = Math.min(slack, room);
    widths[id] = widths[id]! + grant;
    slack -= grant;
  }
  return widths;
}

/**
 * Measure the widest mounted value in each requested column.
 *
 * This walks the cells once rather than querying once per column. The returned widths are intrinsic
 * content widths: `measuredColumnContentWidth` deliberately looks through an ellipsed cell instead of
 * feeding its assigned grid width back into the next layout calculation.
 */
export function measuredColumnContentWidths(
  root: HTMLElement,
  ids: readonly string[],
): Record<string, number> {
  const requested = new Set(ids);
  const widths: Record<string, number> = {};
  for (const cell of root.querySelectorAll<HTMLElement>("[data-col]")) {
    const id = cell.dataset["col"];
    if (!id || !requested.has(id)) continue;
    widths[id] = Math.max(widths[id] ?? 0, measuredColumnContentWidth(cell));
  }
  return widths;
}

export function measuredColumnContentWidth(el: HTMLElement): number {
  const style = getComputedStyle(el);
  if (style.display === "none" || style.position === "absolute" || style.position === "fixed") return 0;
  const padding = numericStyle(style.paddingLeft) + numericStyle(style.paddingRight);
  const children = [...el.children].filter((child): child is HTMLElement => child instanceof HTMLElement);
  const widths = children.map(measuredColumnContentWidth).filter((width) => width > 0);

  // An ellipsed leaf exposes its full text through scrollWidth. A mixed node such as the Title span
  // does too: its card key is a child element but the actual card title is a direct text node. The
  // previous child-only recursion discarded that direct text and auto-fit measured little more than
  // the key. Do not use scrollWidth for every container, though—the root cell's value is its assigned
  // grid width, which would prevent auto-fit from ever shrinking a column.
  const hasDirectText = [...el.childNodes].some(
    (node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()),
  );
  const ownIntrinsicWidth = children.length === 0 || hasDirectText ? el.scrollWidth : 0;
  if (!widths.length) return Math.max(ownIntrinsicWidth, padding);

  const childWidth = style.display.includes("flex")
    ? widths.reduce((total, width) => total + width, 0) + (widths.length - 1) * numericStyle(style.columnGap || style.gap)
    : Math.max(...widths);
  return Math.max(ownIntrinsicWidth, padding + childWidth);
}

function numericStyle(value: string): number {
  return Number.parseFloat(value) || 0;
}

export function applySavedColumnOrder(columns: string[], savedOrder: string[]): string[] {
  if (savedOrder.length === 0) return columns;
  const columnSet = new Set(columns);
  const ordered = savedOrder.filter((id) => columnSet.has(id));
  const missing = columns.filter((id) => !savedOrder.includes(id));
  return [...ordered, ...missing];
}

export function columnWidthsEqual(a: ColumnWidths, b: ColumnWidths): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}

/**
 * "3d ago" for a Created / Updated cell. Shared by the List and Table views so the same timestamp
 * never renders two different ways depending on which view you opened.
 */
export function formatRelativeTime(value: string | Date | null | undefined): string {
  if (!value) return "";
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (Number.isNaN(time)) return "";
  const mins = Math.round((Date.now() - time) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

export function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}
