import type { WorkCatalog } from "@kanera/shared/dto";
import type { PickerGroup } from "../picker-list.component";

/** A card the viewer may queue, with enough context to pick it out of a cross-board list. */
export type PriorityAddableCard = {
  id: string;
  title: string;
  boardId: string;
  boardName: string;
  boardIcon: string | null;
  boardIconColor: string | null;
  listName: string;
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
 * The add picker's rows, grouped per board the way the create-card and scope pickers group theirs,
 * so a cross-board pool of similar titles ("Fix login") stays tellable-apart.
 *
 * Shared rather than per-surface: the drawer, the dock's header "+", the inline "Add card" and the
 * Team Cards lanes all offer the same pool and must present it identically.
 */
export function priorityAddGroups(cards: readonly PriorityAddableCard[]): PickerGroup[] {
  const groups = new Map<string, PickerGroup>();
  for (const card of cards) {
    const group = groups.get(card.boardId) ?? {
      id: card.boardId,
      label: card.boardName,
      icon: card.boardIcon ?? "layout-kanban",
      color: card.boardIconColor,
      options: [],
    };
    group.options.push({ id: card.id, label: card.title, hint: card.listName || null });
    groups.set(card.boardId, group);
  }
  return [...groups.values()];
}
