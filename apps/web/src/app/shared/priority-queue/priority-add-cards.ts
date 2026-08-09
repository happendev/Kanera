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
