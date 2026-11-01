import { describe, expect, it } from "vitest";
import type { WireNote } from "@kanera/shared/events";
import { resolveNoteDrop, visibleNoteRows } from "./note-tree-drop";
import { buildTree } from "./notes.types";

// A
//   A1
//     A1a
//   A2
// B
// C
const notes = [
  note("A", null, 1),
  note("A1", "A", 1),
  note("A1a", "A1", 1),
  note("A2", "A", 2),
  note("B", null, 2),
  note("C", null, 3),
];

function resolve(dragging: string, rowId: string, zone: "top" | "middle" | "bottom", depth: number, expanded: Record<string, boolean> = {}) {
  const roots = buildTree(notes);
  return resolveNoteDrop(visibleNoteRows(roots, expanded), roots, dragging, { rowId, zone }, depth);
}

describe("resolveNoteDrop", () => {
  it("drops below an expanded note as its first child, never after its hidden-away subtree", () => {
    expect(resolve("C", "A", "bottom", 0)).toMatchObject({
      kind: "gap",
      depth: 1,
      parentId: "A",
      move: { noteId: "C", newParentId: "A", afterNoteId: null },
    });
  });

  it("outdents below a last child to the level the pointer asks for", () => {
    expect(resolve("C", "A2", "bottom", 1)).toMatchObject({ depth: 1, move: { newParentId: "A", afterNoteId: "A2" } });
    expect(resolve("C", "A2", "bottom", 0)).toMatchObject({ depth: 0, move: { newParentId: null, afterNoteId: "A" } });
    // Two levels up from A1a's line lands after A, not after A1a's own parent.
    expect(resolve("C", "A1a", "bottom", 0)).toMatchObject({ depth: 1, move: { newParentId: "A", afterNoteId: "A1" } });
  });

  it("keeps a note with children from nesting past the third level", () => {
    // A1 is two levels tall, so it fits inside a top-level note; A is three, so it only moves between roots.
    expect(resolve("A1", "B", "middle", 0)).toMatchObject({ kind: "inside", targetId: "B" });
    expect(resolve("A", "C", "middle", 2)).toMatchObject({ kind: "gap", depth: 0, move: { newParentId: null, afterNoteId: "C" } });
    expect(resolve("A1", "C", "bottom", 5)).toMatchObject({ depth: 1, move: { newParentId: "C", afterNoteId: null } });
  });

  it("reports a gap whose every level would nest too deep", () => {
    // Between A1a and A1b (both level 2) only level 2 fits: fine for a leaf, too deep for B and its child.
    const roots = buildTree([...notes, note("A1b", "A1", 2), note("B1", "B", 1)]);
    const rows = visibleNoteRows(roots, {});
    expect(resolveNoteDrop(rows, roots, "B", { rowId: "A1b", zone: "top" }, 2)).toMatchObject({ kind: "too-deep" });
    expect(resolveNoteDrop(rows, roots, "C", { rowId: "A1b", zone: "top" }, 2)).toMatchObject({ kind: "gap", depth: 2 });
  });

  it("appends to a collapsed note instead of jumping above its hidden children", () => {
    expect(resolve("C", "A", "bottom", 1, { A: false })).toMatchObject({ depth: 1, move: { newParentId: "A", beforeNoteId: null } });
  });

  it("indents and outdents in place while hovering the dragged note or its children", () => {
    expect(resolve("B", "B", "middle", 0)).toMatchObject({ kind: "gap", depth: 0, move: null });
    expect(resolve("B", "B", "middle", 1)).toMatchObject({ depth: 1, move: { newParentId: "A", afterNoteId: "A2" } });
    expect(resolve("A1", "A1a", "middle", 0)).toMatchObject({ depth: 1, move: null });
  });

  it("sends nothing for a drop that leaves the note where it is", () => {
    expect(resolve("B", "A2", "bottom", 0)).toMatchObject({ move: null });
    expect(resolve("B", "C", "top", 0)).toMatchObject({ move: null });
    expect(resolve("A2", "A", "middle", 0)).toMatchObject({ kind: "inside", move: null });
    expect(resolve("A1", "A", "middle", 0)).toMatchObject({ kind: "inside", move: { newParentId: "A", beforeNoteId: null } });
  });
});

function note(id: string, parentNoteId: string | null, position: number): WireNote {
  return { id, parentNoteId, title: id, position: String(position) } as WireNote;
}
