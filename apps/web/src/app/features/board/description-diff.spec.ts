import { describe, expect, it } from "vitest";
import { descriptionDiff, type DescriptionDiffLineKind, type DescriptionDiffUnifiedLine } from "./description-diff";

function lineText(line: DescriptionDiffUnifiedLine): string {
  return line.chunks.map((chunk) => chunk.text).join("");
}

function textOf(lines: DescriptionDiffUnifiedLine[], kind: DescriptionDiffLineKind): string[] {
  return lines.filter((line) => line.kind === kind).map(lineText);
}

function changedText(lines: DescriptionDiffUnifiedLine[], kind: DescriptionDiffLineKind): string[] {
  return lines
    .filter((line) => line.kind === kind)
    .map((line) => line.chunks.filter((chunk) => chunk.changed).map((chunk) => chunk.text).join(""));
}

describe("descriptionDiff", () => {
  it("shows added lines", () => {
    const diff = descriptionDiff("Keep this", "Keep this\nAdd this");

    expect(diff.hasChanges).toBe(true);
    expect(textOf(diff.lines, "context")).toEqual(["Keep this"]);
    expect(textOf(diff.lines, "added")).toEqual(["Add this"]);
    expect(changedText(diff.lines, "added")).toEqual(["Add this"]);
    expect(textOf(diff.lines, "removed")).toEqual([]);
  });

  it("shows removed lines", () => {
    const diff = descriptionDiff("Keep this\nRemove this", "Keep this");

    expect(textOf(diff.lines, "context")).toEqual(["Keep this"]);
    expect(textOf(diff.lines, "removed")).toEqual(["Remove this"]);
    expect(changedText(diff.lines, "removed")).toEqual(["Remove this"]);
    expect(textOf(diff.lines, "added")).toEqual([]);
  });

  it("highlights changed words within changed lines", () => {
    const diff = descriptionDiff("Build the small audit view", "Build the detailed audit view");

    expect(textOf(diff.lines, "removed")).toEqual(["Build the small audit view"]);
    expect(textOf(diff.lines, "added")).toEqual(["Build the detailed audit view"]);
    expect(changedText(diff.lines, "removed")).toEqual(["small"]);
    expect(changedText(diff.lines, "added")).toEqual(["detailed"]);
  });

  it("shows empty-to-text changes as added lines", () => {
    const diff = descriptionDiff(null, "Fresh notes");

    expect(diff.hasChanges).toBe(true);
    expect(textOf(diff.lines, "added")).toEqual(["Fresh notes"]);
    expect(textOf(diff.lines, "removed")).toEqual([]);
  });

  it("shows text-to-empty changes as removed lines", () => {
    const diff = descriptionDiff("Old notes", "");

    expect(diff.hasChanges).toBe(true);
    expect(textOf(diff.lines, "removed")).toEqual(["Old notes"]);
    expect(textOf(diff.lines, "added")).toEqual([]);
  });

  it("keeps surrounding context lines around a change", () => {
    const from = "L1\nL2\nL3\nOLD\nL5\nL6\nL7";
    const to = "L1\nL2\nL3\nNEW\nL5\nL6\nL7";
    const diff = descriptionDiff(from, to);

    // Up to 3 lines of context kept on each side; no gap because there are only 3.
    expect(textOf(diff.lines, "context")).toEqual(["L1", "L2", "L3", "L5", "L6", "L7"]);
    expect(textOf(diff.lines, "removed")).toEqual(["OLD"]);
    expect(textOf(diff.lines, "added")).toEqual(["NEW"]);
    expect(textOf(diff.lines, "gap")).toEqual([]);
  });

  it("collapses a large unchanged region into a gap separator", () => {
    const before = ["X", "a", "b", "c", "d", "e", "f", "g", "h"]; // 9 unchanged lines after the change
    const from = ["OLD", ...before].join("\n");
    const to = ["NEW", ...before].join("\n");
    const diff = descriptionDiff(from, to);

    expect(textOf(diff.lines, "removed")).toEqual(["OLD"]);
    expect(textOf(diff.lines, "added")).toEqual(["NEW"]);
    // Trailing context keeps the first 3 lines; the remaining 6 collapse to a gap.
    expect(textOf(diff.lines, "context")).toEqual(["X", "a", "b"]);
    expect(textOf(diff.lines, "gap")).toEqual(["6 unchanged lines"]);
  });

  it("flags blank-line-only changes as neither content nor formatting changes", () => {
    const diff = descriptionDiff("Keep this", "\n\nKeep this\n");

    expect(diff.hasChanges).toBe(false);
    expect(diff.formattingOnly).toBe(false);
    expect(diff.lines).toEqual([]);
  });

  it("flags markdown/link-only edits as formatting-only", () => {
    const diff = descriptionDiff("## Ship **this**\n\n- [link](https://example.com)", "Ship this\nlink");

    expect(diff.hasChanges).toBe(false);
    expect(diff.formattingOnly).toBe(true);
    expect(diff.lines).toEqual([]);
  });
});
