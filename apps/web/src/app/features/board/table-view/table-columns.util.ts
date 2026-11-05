import type { ColumnWidths } from "./view-preference";

export const ROW_INTERACTION_STOP_SELECTOR =
  ".lv-row-stop, .tv-row-stop, k-card-actions-menu, k-card-quick-edit, .cam-panel, .cqe-panel, .bp-panel, .dp-panel, .lp-panel, .mp-panel, .sp-panel, .qe-panel, .qe-popover";

export function builtinColumnLabel(id: string): string {
  switch (id) {
    case "title": return $localize`:Table column header - card title:Title`;
    case "priority": return $localize`:Table column header - the card's rank in the viewer's Up next queue:Up next order`;
    case "status": return $localize`:Table column header - the list the card is in:List`;
    case "board": return $localize`:Table column header - the board the card is on:Board`;
    case "assignees": return $localize`:Table column header:Assignees`;
    case "start": return $localize`:Table column header - the card's planned start date:Start date`;
    case "due": return $localize`:Table column header:Due date`;
    case "inProgress": return $localize`:Table column header - tracked working time the card has spent in In progress lists:Time in progress`;
    case "labels": return $localize`:Table column header:Labels`;
    case "checklist": return $localize`:Table column header - checklist progress:Checklist`;
    case "updated": return $localize`:Table column header - when the card was last updated:Updated`;
    case "created": return $localize`:Table column header - when the card was created:Created`;
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
    case "start": return "calendar-time";
    case "due": return "calendar-event";
    case "inProgress": return "progress";
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
 * Hand the width secondary columns are not using to the first column (Title) while it is still
 * truncating. The defaults are sized for a typical value ("Omar, Priya", two label chips, a date and
 * its icon), so a sheet whose values ran shorter carried a band of empty space in those columns while
 * the one column people read ellipsed beside them.
 *
 * Width only moves between tracks, so the sheet's total width (and whether it scrolls) is unchanged.
 * Only a column that starts inside the visible sheet (`available`) lends, and never so much that its
 * left edge leaves it: a loan from column j moves the columns between Title and j right by the loan,
 * but they stay left of j's new left edge, so every column that was fully in view stays fully in view.
 * Lending from a column off to the right would push visible ones out. The column straddling the edge
 * can show less of itself, which is the trade: it was already cut, and Title is the column people read.
 *
 * A donor never goes below `floorFor` (its measured content plus breathing room); a column without a
 * measurement yet, or one the viewer sized by hand, gives nothing. A hand-sized Title takes nothing.
 */
export function lendSpareWidthToFirst(options: {
  ids: readonly string[];
  widths: Record<string, number>;
  available: number;
  targetFor: (id: string) => number;
  floorFor: (id: string) => number;
  isPinned?: (id: string) => boolean;
}): Record<string, number> {
  const { ids, widths, available, targetFor, floorFor, isPinned } = options;
  const [first, ...rest] = ids;
  if (first === undefined || isPinned?.(first)) return widths;
  let need = Math.floor(targetFor(first) - widths[first]!);
  if (!(need > 0)) return widths;

  const next = { ...widths };
  // A column's left edge moves only by its own loan (Title grows by what earlier columns gave, and
  // they shrank by the same), and everything before the last lender ends at that lender's left edge.
  // So capping each loan at "left edge stays in view" keeps every earlier column in view as well.
  let left = widths[first]!;
  for (const id of rest) {
    const start = left;
    left += widths[id]!;
    if (need <= 0 || start >= available) break;
    if (isPinned?.(id)) continue;
    const spare = Math.floor(Math.min(next[id]! - floorFor(id), available - start));
    if (spare <= 0) continue;
    const loan = Math.min(spare, need);
    next[id] = next[id]! - loan;
    next[first] = next[first]! + loan;
    need -= loan;
  }
  return next;
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
  return measureElement(el).width;
}

/**
 * The element's intrinsic border-box width, plus its inline margins for the parent to add. Margins
 * count because the cell triggers bleed over the cell's padding with a negative margin (and stacked
 * avatars overlap the same way): summing border boxes alone counted that padding twice, so every
 * trigger column measured ~20px wider than its content and auto-fit and the Title loan left a band of
 * empty space in each.
 */
function measureElement(el: HTMLElement): { width: number; margin: number } {
  const style = getComputedStyle(el);
  if (style.display === "none" || style.position === "absolute" || style.position === "fixed") return { width: 0, margin: 0 };
  const margin = numericStyle(style.marginLeft) + numericStyle(style.marginRight);
  // Border too: an avatar's ring is a border on its host, and leaving it out undercounted a face pile.
  const border = numericStyle(style.borderLeftWidth) + numericStyle(style.borderRightWidth);
  const padding = numericStyle(style.paddingLeft) + numericStyle(style.paddingRight) + border;
  const children = [...el.children].filter((child): child is HTMLElement => child instanceof HTMLElement);
  const widths = children
    .map(measureElement)
    .filter((child) => child.width > 0)
    .map((child) => Math.max(0, child.width + child.margin));

  // An ellipsed leaf exposes its full text through scrollWidth. A mixed node such as the Title span
  // does too: its card key is a child element but the actual card title is a direct text node. The
  // previous child-only recursion discarded that direct text and auto-fit measured little more than
  // the key. Do not use scrollWidth for every container, though—the root cell's value is its assigned
  // grid width, which would prevent auto-fit from ever shrinking a column.
  const hasDirectText = [...el.childNodes].some(
    (node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()),
  );
  // scrollWidth is the padding box, so the border is added back.
  const ownIntrinsicWidth = children.length === 0 || hasDirectText ? el.scrollWidth + border : 0;
  if (!widths.length) return { width: Math.max(ownIntrinsicWidth, padding), margin };

  const childWidth = style.display.includes("flex")
    ? widths.reduce((total, width) => total + width, 0) + (widths.length - 1) * numericStyle(style.columnGap || style.gap)
    : Math.max(...widths);
  return { width: Math.max(ownIntrinsicWidth, padding + childWidth), margin };
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

export { formatRelativeTime } from "../../../shared/date-format";

export function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}
