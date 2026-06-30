import type { WireNote } from "@kanera/shared/events";

export type NoteScopeValue = "personal" | "team";

export interface NotesScopeKey {
  /** workspaceId-or-boardId qualifier for sibling ordering / room joins */
  workspaceId: string;
  boardId: string | null;
}

export interface NoteTreeNode extends WireNote {
  children: NoteTreeNode[];
}

export function buildTree(notes: WireNote[]): NoteTreeNode[] {
  const byId = new Map<string, NoteTreeNode>();
  for (const n of notes) byId.set(n.id, { ...n, children: [] });
  const roots: NoteTreeNode[] = [];
  for (const node of byId.values()) {
    if (node.parentNoteId && byId.has(node.parentNoteId)) {
      byId.get(node.parentNoteId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortByPosition = (a: NoteTreeNode, b: NoteTreeNode) => Number(a.position) - Number(b.position);
  roots.sort(sortByPosition);
  for (const node of byId.values()) node.children.sort(sortByPosition);
  return roots;
}
