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

  it("flags cosmetic emphasis changes as formatting-only", () => {
    const diff = descriptionDiff("Ship **this**", "Ship _this_");

    expect(diff.hasChanges).toBe(false);
    expect(diff.formattingOnly).toBe(true);
    expect(diff.lines).toEqual([]);
  });

  it("shows a Markdown autolink alongside the reported list additions", () => {
    const from = ["Make sure exports still work.", "", "This will be a huge win."].join("\n");
    const to = [
      "Make sure exports still work.",
      "",
      "This will be a huge win.",
      "",
      "<https://antel-portal-prod.happen.zone/Uplift/UpliftList>",
      " - Filters",
      " - Searching",
    ].join("\n");
    const diff = descriptionDiff(from, to);

    expect(textOf(diff.lines, "added").filter(Boolean)).toEqual([
      "https://antel-portal-prod.happen.zone/Uplift/UpliftList",
      "- Filters",
      "- Searching",
    ]);
    expect(textOf(diff.lines, "added").filter((line) => line === "")).toHaveLength(2);
  });

  it("shows changed link destinations even when their labels match", () => {
    const diff = descriptionDiff("[docs](https://old.example)", "[docs](https://new.example)");

    expect(textOf(diff.lines, "removed")).toEqual(["docs <https://old.example>"]);
    expect(textOf(diff.lines, "added")).toEqual(["docs <https://new.example>"]);
  });

  it("shows changed mention targets even when their labels match", () => {
    const from = "@[Ada](kanera-user:11111111-1111-1111-1111-111111111111)";
    const to = "@[Ada](kanera-user:22222222-2222-2222-2222-222222222222)";
    const diff = descriptionDiff(from, to);

    expect(textOf(diff.lines, "removed")).toEqual(["@Ada <kanera-user:11111111-1111-1111-1111-111111111111>"]);
    expect(textOf(diff.lines, "added")).toEqual(["@Ada <kanera-user:22222222-2222-2222-2222-222222222222>"]);
  });

  it("shows image sources, including images without alt text", () => {
    const diff = descriptionDiff("![](https://old.example/image.png)", "![Chart](https://new.example/image.png)");

    expect(textOf(diff.lines, "removed")).toEqual(["Image <https://old.example/image.png>"]);
    expect(textOf(diff.lines, "added")).toEqual(["Image: Chart <https://new.example/image.png>"]);
  });

  it("shows task state changes", () => {
    const diff = descriptionDiff("- [ ] Ship", "- [x] Ship");

    expect(textOf(diff.lines, "removed")).toEqual(["- [ ] Ship"]);
    expect(textOf(diff.lines, "added")).toEqual(["- [x] Ship"]);
  });

  it("shows list hierarchy and heading-level changes", () => {
    const listDiff = descriptionDiff("- Parent\n  - Child", "- Parent\n- Child");
    const headingDiff = descriptionDiff("## Release", "### Release");

    expect(textOf(listDiff.lines, "removed")).toContain("  - Child");
    expect(textOf(listDiff.lines, "added")).toContain("- Child");
    expect(textOf(headingDiff.lines, "removed")).toEqual(["## Release"]);
    expect(textOf(headingDiff.lines, "added")).toEqual(["### Release"]);
  });

  it("shows ordered-list starts and paragraph boundaries", () => {
    const listDiff = descriptionDiff("1. First\n2. Second", "3. First\n4. Second");
    const paragraphDiff = descriptionDiff("First\nSecond", "First\n\nSecond");

    expect(textOf(listDiff.lines, "removed")).toEqual(["1. First", "2. Second"]);
    expect(textOf(listDiff.lines, "added")).toEqual(["3. First", "4. Second"]);
    expect(textOf(paragraphDiff.lines, "added")).toEqual([""]);
  });

  it("preserves punctuation and meaningful whitespace in code", () => {
    const diff = descriptionDiff("```ts\nconst value = foo_bar *  2; // ~exact~\n```", "```ts\nconst value = foo_bar * 2; // ~exact~\n```");

    expect(textOf(diff.lines, "removed")).toEqual(["const value = foo_bar *  2; // ~exact~"]);
    expect(textOf(diff.lines, "added")).toEqual(["const value = foo_bar * 2; // ~exact~"]);
  });

  it("does not mistake comparison text or raw HTML for disposable tags", () => {
    const comparisonDiff = descriptionDiff("Keep", "Keep\nx < y and z > q");
    const htmlDiff = descriptionDiff('<widget data-mode="old">', '<widget data-mode="new">');

    expect(textOf(comparisonDiff.lines, "added")).toEqual(["x < y and z > q"]);
    expect(textOf(htmlDiff.lines, "removed")).toEqual(['<widget data-mode="old">']);
    expect(textOf(htmlDiff.lines, "added")).toEqual(['<widget data-mode="new">']);
  });
});
