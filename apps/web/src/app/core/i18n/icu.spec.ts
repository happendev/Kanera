import { describe, expect, it } from "vitest";
import { icu } from "./icu";

// Pure-function edge cases the E2E suite cannot reach: these messages render in the source language
// there, so only these tests exercise the plural categories and nesting other languages rely on.
describe("icu", () => {
  const cards = "{count, plural, =0 {No cards} one {# card} other {# cards}}";

  it("prefers an exact =N case over the plural category", () => {
    expect(icu(cards, { count: 0 })).toBe("No cards");
    expect(icu(cards, { count: 1 })).toBe("1 card");
    expect(icu(cards, { count: 2 })).toBe("2 cards");
  });

  it("formats # with locale digit grouping", () => {
    expect(icu(cards, { count: 12000 })).toBe(`${new Intl.NumberFormat("en-GB").format(12000)} cards`);
  });

  it("falls back to other when a language lacks the category", () => {
    expect(icu("{count, plural, other {# 枚}}", { count: 1 })).toBe("1 枚");
  });

  it("evaluates select, plain arguments and nesting", () => {
    const message = "{actor} {kind, select, comment {left {count, plural, one {a comment} other {# comments}}} other {made changes}}";
    expect(icu(message, { actor: "Priya", kind: "comment", count: 3 })).toBe("Priya left 3 comments");
    expect(icu(message, { actor: "Priya", kind: "move", count: 3 })).toBe("Priya made changes");
  });

  it("leaves text without ICU untouched", () => {
    expect(icu("Plain text, with # and punctuation.", {})).toBe("Plain text, with # and punctuation.");
  });
});
