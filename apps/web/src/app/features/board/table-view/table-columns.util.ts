import type { ColumnWidths } from "./view-preference";

export const ROW_INTERACTION_STOP_SELECTOR =
  ".lv-row-stop, .tv-row-stop, k-card-actions-menu, k-card-quick-edit, .cam-panel, .cqe-panel, .bp-panel, .dp-panel, .lp-panel, .mp-panel, .sp-panel, .qe-panel, .qe-popover";

export function builtinColumnLabel(id: string): string {
  switch (id) {
    case "title": return "Title";
    case "status": return "List";
    case "board": return "Board";
    case "assignees": return "Assignees";
    case "due": return "Due date";
    case "labels": return "Labels";
    case "checklist": return "Checklist";
    case "updated": return "Updated";
    case "created": return "Created";
    case "description": return "Description";
    default: return id;
  }
}

export function builtinColumnIcon(id: string): string {
  switch (id) {
    case "title": return "forms";
    case "status": return "list-details";
    case "board": return "layout-kanban";
    case "assignees": return "users";
    case "due": return "calendar-event";
    case "labels": return "tag";
    case "checklist": return "checkbox";
    case "updated": return "history";
    case "created": return "plus";
    case "description": return "align-left";
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

/** Plain-text one-liner from a card's rich-text description, for the Description column. */
export function descriptionPreview(raw: string | null | undefined, maxLength = 80): string {
  if (!raw) return "";
  const stripped = raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return stripped.length > maxLength ? `${stripped.slice(0, maxLength - 3)}…` : stripped;
}

export function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}
