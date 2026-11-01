import type { NoteTreeNode } from "./notes.types";

/** Deepest tree level (0-based): the API allows notes three levels deep (MAX_NOTE_TREE_DEPTH). */
const MAX_NOTE_DEPTH = 2;

export interface NoteMoveRequest {
  noteId: string;
  newParentId: string | null;
  afterNoteId?: string | null;
  beforeNoteId?: string | null;
}

/** One row the tree currently renders, in on-screen order. */
export interface VisibleNoteRow {
  node: NoteTreeNode;
  depth: number;
  parentId: string | null;
}

/** Which band of the hovered row the pointer is in. */
export type RowZone = "top" | "middle" | "bottom";

export type NoteDropTarget =
  /** A line between two rows at `depth`; `edge` says which edge of `rowId` the line sits on. */
  | { kind: "gap"; depth: number; parentId: string | null; rowId: string; edge: "top" | "bottom"; move: NoteMoveRequest | null }
  | { kind: "inside"; targetId: string; move: NoteMoveRequest | null }
  /** The gap exists but every level it allows would nest the dragged subtree past MAX_NOTE_DEPTH. */
  | { kind: "too-deep"; rowId: string; edge: "top" | "bottom" };

export function visibleNoteRows(roots: NoteTreeNode[], expanded: Record<string, boolean>): VisibleNoteRow[] {
  const rows: VisibleNoteRow[] = [];
  const walk = (nodes: NoteTreeNode[], depth: number, parentId: string | null) => {
    for (const node of nodes) {
      rows.push({ node, depth, parentId });
      if (node.children.length > 0 && expanded[node.id] !== false) walk(node.children, depth + 1, node.id);
    }
  };
  walk(roots, 0, null);
  return rows;
}

/** Levels the node occupies including itself: a leaf is 1, a note with children is 2, and so on. */
function subtreeHeight(node: NoteTreeNode): number {
  return 1 + Math.max(0, ...node.children.map(subtreeHeight));
}

/**
 * Resolves where a dragged note would land. Gaps work like an outliner: the line sits between two
 * rendered rows and its level can be anything from the row below's level (so the note never jumps
 * past rows it appears above) to one deeper than the row above (its first child). Within that range
 * `desiredDepth` — the drag's starting level shifted by how far the pointer moved sideways — picks
 * the level, so dragging left outdents and dragging right indents.
 *
 * The dragged note and its descendants are not targets: hovering them resolves to the gap the note
 * already occupies, which is how a note is indented or outdented in place.
 */
export function resolveNoteDrop(
  rows: VisibleNoteRow[],
  roots: NoteTreeNode[],
  draggingId: string,
  hover: { rowId: string; zone: RowZone },
  desiredDepth: number,
): NoteDropTarget | null {
  const dragIndex = rows.findIndex((row) => row.node.id === draggingId);
  const hoverIndex = rows.findIndex((row) => row.node.id === hover.rowId);
  if (dragIndex < 0 || hoverIndex < 0) return null;
  const dragged = rows[dragIndex]!;
  const dragEnd = dragIndex + visibleDescendantCount(rows, dragIndex);
  const height = subtreeHeight(dragged.node);
  const byId = new Map(rows.map((row) => [row.node.id, row]));

  const isDragged = (index: number) => index >= dragIndex && index <= dragEnd;
  const prevCandidate = (index: number) => {
    for (let i = index - 1; i >= 0; i--) if (!isDragged(i)) return rows[i]!;
    return null;
  };
  const nextCandidate = (index: number) => {
    for (let i = index + 1; i < rows.length; i++) if (!isDragged(i)) return rows[i]!;
    return null;
  };

  let prev: VisibleNoteRow | null;
  let next: VisibleNoteRow | null;
  let lineRow: string;
  let edge: "top" | "bottom";
  if (isDragged(hoverIndex)) {
    prev = prevCandidate(dragIndex);
    next = nextCandidate(dragEnd);
    lineRow = draggingId;
    edge = "top";
  } else {
    const hovered = rows[hoverIndex]!;
    if (hover.zone === "middle" && hovered.depth + height <= MAX_NOTE_DEPTH) {
      return {
        kind: "inside",
        targetId: hovered.node.id,
        move: unlessNoop({ noteId: draggingId, newParentId: hovered.node.id, beforeNoteId: null }, dragged, roots, byId),
      };
    }
    // A middle hover on a row that cannot take the note as a child falls back to the nearer edge.
    const above = hover.zone === "top";
    prev = above ? prevCandidate(hoverIndex) : hovered;
    next = above ? hovered : nextCandidate(hoverIndex);
    lineRow = hovered.node.id;
    edge = above ? "top" : "bottom";
  }

  const minDepth = next ? next.depth : 0;
  const maxDepth = Math.min(prev ? prev.depth + 1 : 0, MAX_NOTE_DEPTH + 1 - height);
  if (minDepth > maxDepth) return { kind: "too-deep", rowId: lineRow, edge };
  const depth = Math.min(maxDepth, Math.max(minDepth, desiredDepth));

  let move: NoteMoveRequest;
  if (!prev) {
    move = { noteId: draggingId, newParentId: null, afterNoteId: null };
  } else if (depth === prev.depth + 1) {
    // First child of the row above. A collapsed row hides its children, so the line under it reads
    // as "into this note" and appends after the hidden children instead of jumping above them.
    const collapsedWithChildren = prev.node.children.length > 0 && next?.parentId !== prev.node.id;
    move = collapsedWithChildren
      ? { noteId: draggingId, newParentId: prev.node.id, beforeNoteId: null }
      : { noteId: draggingId, newParentId: prev.node.id, afterNoteId: null };
  } else {
    let anchor = prev;
    while (anchor.depth > depth) anchor = byId.get(anchor.parentId!)!;
    move = { noteId: draggingId, newParentId: anchor.parentId, afterNoteId: anchor.node.id };
  }
  return { kind: "gap", depth, parentId: move.newParentId, rowId: lineRow, edge, move: unlessNoop(move, dragged, roots, byId) };
}

function visibleDescendantCount(rows: VisibleNoteRow[], index: number): number {
  const depth = rows[index]!.depth;
  let count = 0;
  for (let i = index + 1; i < rows.length && rows[i]!.depth > depth; i++) count++;
  return count;
}

/** Null when the move would leave the note exactly where it is, so the drop sends nothing. */
function unlessNoop(
  move: NoteMoveRequest,
  dragged: VisibleNoteRow,
  roots: NoteTreeNode[],
  byId: Map<string, VisibleNoteRow>,
): NoteMoveRequest | null {
  if (move.newParentId !== dragged.parentId) return move;
  const siblings = move.newParentId ? byId.get(move.newParentId)!.node.children : roots;
  const index = siblings.findIndex((node) => node.id === dragged.node.id);
  const unchanged =
    (move.afterNoteId === null && index === 0) ||
    (move.afterNoteId != null && siblings[index - 1]?.id === move.afterNoteId) ||
    (move.beforeNoteId === null && index === siblings.length - 1);
  return unchanged ? null : move;
}
