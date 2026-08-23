import type { WorkCatalog } from "@kanera/shared/dto";
import { type DueDateSlot, formatDueDate, isDueSoon, isOverdue } from "../../features/board/due-date.util";
import type { PickerGroup } from "../picker-list.component";

/** A card the viewer may queue, with enough context to pick it out of a cross-board list. */
export type PriorityAddableCard = {
  id: string;
  title: string;
  /** The human reference (PROJ-123). Shown above the title, and what makes typing a key search. */
  key: string;
  boardId: string;
  boardName: string;
  boardIcon: string | null;
  boardIconColor: string | null;
  /** Groups the picker's rows: cards in one board are sectioned by the list they sit in. */
  listId: string;
  listName: string;
  listIcon: string | null;
  listColor: string | null;
  /**
   * Due date, in the same three parts every other card surface carries it. Rendered as the row's
   * trailing meta and coloured when it is overdue or close — this picker's whole job is choosing what
   * to do next, and that is not a decision anyone makes from titles alone.
   */
  dueDateLocalDate: string | null;
  dueDateSlot: DueDateSlot | null;
  dueDateTimezone: string | null;
};

/**
 * Board ids in the order the navigation sidebar presents them — organisations, each one's
 * workspaces, each workspace's boards, all in catalog order (which the shell's `/home/boards`
 * ordering matches, standalone boards last).
 *
 * Shared because `priorityAddGroups` groups by *first appearance*: whatever order a candidate array
 * arrives in becomes the picker's section order, so every surface that builds one has to apply this
 * same rule or its sections land somewhere the reader has never seen a board list sit.
 */
export function navBoardOrder(catalog: WorkCatalog): Map<string, number> {
  const order = new Map<string, number>();
  for (const organisation of catalog.organisations) {
    for (const workspace of catalog.workspaces) {
      if (workspace.organisationId !== organisation.id) continue;
      for (const board of catalog.boards) {
        if (board.workspaceId === workspace.id) order.set(board.id, order.size);
      }
    }
  }
  return order;
}

/**
 * The add picker's rows: sectioned board › list, one row per card carrying its key, title and due
 * date.
 *
 * The list is a *heading*, not a per-row hint, which is the difference between a readable picker and
 * the one this replaced. Up next candidates are a viewer's assigned cards, and assigned work clusters
 * hard in a handful of lists — so every row repeated the same list name under its title, spending a
 * second line per row to say nothing and leaving a wall of similar titles ("Approve the…", "Review
 * the…") with no way to tell them apart. Sectioning states each list once and gives the row's second
 * line back to the two facts that actually separate one candidate from another.
 *
 * Shared rather than per-surface: the drawer, the dock's header "+", the inline "Add card" and the
 * Team Cards lanes all offer the same pool and must present it identically.
 */
export function priorityAddGroups(
  cards: readonly PriorityAddableCard[],
  options: { showCardKeys?: boolean; now?: Date } = {},
): PickerGroup[] {
  const now = options.now ?? new Date();
  // Two levels of first-appearance order, boards then lists inside each board, rather than one flat
  // map keyed on both. The picker renders a board heading once per *consecutive* run of its list
  // sections, so a flat map would print "Roadmap" twice for an input ordered board A → board B →
  // board A. Callers do sort by board then list, but a picker that looks broken when they slip is a
  // worse trade than one nested loop.
  const boards = new Map<string, Map<string, PickerGroup>>();
  for (const card of cards) {
    const lists = boards.get(card.boardId) ?? new Map<string, PickerGroup>();
    // Keyed on the list *id*, never its name: lists are workspace-scoped in Kanera, so a name is
    // genuinely shared and two boards' sections must stay apart.
    const group = lists.get(card.listId) ?? {
      id: `${card.boardId}:${card.listId}`,
      label: card.listName || "No list",
      icon: card.listIcon || "list",
      color: card.listColor,
      parent: {
        id: card.boardId,
        label: card.boardName,
        icon: card.boardIcon ?? "layout-kanban",
        color: card.boardIconColor,
      },
      options: [],
    };
    group.options.push({
      id: card.id,
      label: card.title,
      // Suppressed with the app-wide card key preference, the same as every other surface that shows
      // one. Search follows what is rendered, so hiding keys also stops them matching — which is the
      // honest behaviour for a reference the viewer has chosen not to see.
      overline: options.showCardKeys ? card.key : null,
      trailing: card.dueDateLocalDate
        ? formatDueDate(card.dueDateLocalDate, card.dueDateSlot, card.dueDateTimezone)
        : null,
      trailingChip: true,
      trailingTone: dueTone(card, now),
      // The row's own icon would only repeat its section's list icon. A blank slot keeps every title
      // on one left edge, which is what makes a column of similar titles scannable at all.
      icon: null,
    });
    lists.set(card.listId, group);
    boards.set(card.boardId, lists);
  }
  return [...boards.values()].flatMap((lists) => [...lists.values()]);
}

/** Overdue and due-soon use the same predicates as the queue rows' due chip, so the two agree. */
function dueTone(card: PriorityAddableCard, now: Date): "muted" | "warning" | "danger" {
  const { dueDateLocalDate: date, dueDateSlot: slot, dueDateTimezone: zone } = card;
  if (isOverdue(date, slot, zone, now)) return "danger";
  if (isDueSoon(date, slot, zone, now)) return "warning";
  return "muted";
}
