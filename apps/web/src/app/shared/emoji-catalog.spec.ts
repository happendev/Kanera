import { describe, expect, it } from "vitest";
import { EMOJI_ITEMS, shortcodeToEmoji } from "./emoji-catalog";

describe("compact emoji catalog", () => {
  it("keeps the full searchable Unicode catalog without fallback-image metadata", () => {
    expect(EMOJI_ITEMS.length).toBeGreaterThan(1_900);
    expect(shortcodeToEmoji("rocket")?.emoji).toBe("🚀");
    expect(shortcodeToEmoji("thumbsup")?.emoji).toBe("👍");
    // Text-default Unicode symbols need VS16 now that the editor no longer
    // relies on Tiptap's network fallback images for emoji presentation.
    expect(shortcodeToEmoji("transgender_symbol")?.emoji).toBe("⚧️");
    expect(EMOJI_ITEMS.some((emoji) => emoji.group === "flags")).toBe(true);
    expect(EMOJI_ITEMS.every((emoji) =>
      Object.keys(emoji).sort().join(",") === "emoji,group,name,shortcodes,tags"
    )).toBe(true);
  });
});
