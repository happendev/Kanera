import { beforeEach, describe, expect, it } from "vitest";
import { STORAGE_KEYS } from "../../core/browser/browser-contracts";
import {
  draftHasContent,
  emptyComposerDraft,
  readComposerDraft,
  writeComposerDraft,
  type CardComposerDraft,
} from "./card-composer-draft";

function draft(overrides: Partial<CardComposerDraft> = {}): CardComposerDraft {
  return { ...emptyComposerDraft(), ...overrides };
}

describe("card composer drafts", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("round-trips a draft per board", () => {
    writeComposerDraft("board-1", draft({ title: "Ship it", labelIds: ["l1"] }));
    writeComposerDraft("board-2", draft({ title: "Other board" }));

    expect(readComposerDraft("board-1")?.title).toBe("Ship it");
    expect(readComposerDraft("board-1")?.labelIds).toEqual(["l1"]);
    expect(readComposerDraft("board-2")?.title).toBe("Other board");
    expect(readComposerDraft("board-3")).toBeNull();
  });

  // A list id is set by the composer itself the moment it opens, so a draft carrying only that is
  // not user work: persisting it would show a "recovered draft" banner nobody caused.
  it("does not persist a draft that holds only a seeded list", () => {
    writeComposerDraft("board-1", draft({ listId: "list-1" }));
    expect(readComposerDraft("board-1")).toBeNull();
    expect(draftHasContent(draft({ listId: "list-1" }))).toBe(false);
    expect(draftHasContent(draft({ listId: "list-1", title: "x" }))).toBe(true);
  });

  // The description is editor-serialised markdown: blank lines survive trim() as hard-break
  // backslashes, and treating those as content would resurrect an empty composer as a "draft".
  it("does not persist a description of only blank lines", () => {
    expect(draftHasContent(draft({ description: "\\\n \n\\\n" }))).toBe(false);
    writeComposerDraft("board-1", draft({ description: "\\\n \n\\\n", listId: "list-1" }));
    expect(readComposerDraft("board-1")).toBeNull();

    expect(draftHasContent(draft({ description: "Real text" }))).toBe(true);
  });

  it("clears a board's draft without touching the others", () => {
    writeComposerDraft("board-1", draft({ title: "One" }));
    writeComposerDraft("board-2", draft({ title: "Two" }));

    writeComposerDraft("board-1", null);

    expect(readComposerDraft("board-1")).toBeNull();
    expect(readComposerDraft("board-2")?.title).toBe("Two");
  });

  it("drops drafts older than the retention window", () => {
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    localStorage.setItem(
      STORAGE_KEYS.CARD_COMPOSER_DRAFTS,
      JSON.stringify({ "board-1": { ...draft({ title: "Stale" }), savedAt: eightDaysAgo } }),
    );

    expect(readComposerDraft("board-1")).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.CARD_COMPOSER_DRAFTS)).toBeNull();
  });

  // Storage is hand-editable and survives shape changes across releases, so a partial entry has to
  // restore what it can rather than throw inside the composer's constructor.
  it("tolerates malformed and partial stored entries", () => {
    localStorage.setItem(STORAGE_KEYS.CARD_COMPOSER_DRAFTS, "{not json");
    expect(readComposerDraft("board-1")).toBeNull();

    localStorage.setItem(
      STORAGE_KEYS.CARD_COMPOSER_DRAFTS,
      JSON.stringify({
        "board-1": { title: "Partial", labelIds: ["ok", 7], dueDateSlot: "nonsense", customFields: { f1: { valueText: "x" }, f2: {} }, savedAt: Date.now() },
      }),
    );

    const restored = readComposerDraft("board-1");
    expect(restored?.title).toBe("Partial");
    expect(restored?.labelIds).toEqual(["ok"]);
    expect(restored?.dueDateSlot).toBe("anyTime");
    expect(restored?.customFields).toEqual({ f1: { valueText: "x" } });
  });
});
