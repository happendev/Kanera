import { describe, expect, it } from "vitest";
import { matchSegments } from "./match-highlight.component";

describe("matchSegments", () => {
  it("returns the whole text unmarked when there is no query", () => {
    expect(matchSegments("Design", "")).toEqual([{ text: "Design", match: false }]);
    expect(matchSegments("Design", "   ")).toEqual([{ text: "Design", match: false }]);
    expect(matchSegments("", "x")).toEqual([]);
  });

  it("marks a case-insensitive match and keeps the original casing", () => {
    expect(matchSegments("Bug Report", "REP")).toEqual([
      { text: "Bug ", match: false },
      { text: "Rep", match: true },
      { text: "ort", match: false },
    ]);
  });

  it("trims the query the way the filter does", () => {
    expect(matchSegments("Backend", "  end ")).toEqual([
      { text: "Back", match: false },
      { text: "end", match: true },
    ]);
  });

  it("marks every occurrence, including at the edges", () => {
    expect(matchSegments("ana banana", "an")).toEqual([
      { text: "an", match: true },
      { text: "a b", match: false },
      { text: "an", match: true },
      { text: "an", match: true },
      { text: "a", match: false },
    ]);
  });

  it("returns no mark for text the filter would not match", () => {
    expect(matchSegments("Design", "xyz")).toEqual([{ text: "Design", match: false }]);
  });

  it("does not fold diacritics, matching the filter's plain substring rule", () => {
    expect(matchSegments("Café", "cafe")).toEqual([{ text: "Café", match: false }]);
    expect(matchSegments("Café", "CAFÉ")).toEqual([{ text: "Café", match: true }]);
  });

  it("keeps offsets right after a character whose lower case is longer", () => {
    // "İ".toLowerCase() is two code units; per-character mapping keeps the later match aligned.
    expect(matchSegments("İstanbul team", "team")).toEqual([
      { text: "İstanbul ", match: false },
      { text: "team", match: true },
    ]);
  });

  it("treats markup in the text as plain characters", () => {
    expect(matchSegments("<b>bold</b>", "b>")).toEqual([
      { text: "<", match: false },
      { text: "b>", match: true },
      { text: "bold</", match: false },
      { text: "b>", match: true },
    ]);
  });
});
