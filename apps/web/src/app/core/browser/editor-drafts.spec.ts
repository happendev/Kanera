import { beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE_KEYS } from "./browser-contracts";
import { EditorDrafts } from "./editor-drafts";

describe("EditorDrafts", () => {
  let drafts: EditorDrafts;

  beforeEach(() => {
    localStorage.clear();
    drafts = new EditorDrafts();
  });

  it("saves, loads, and clears active drafts", () => {
    drafts.save({
      userId: "user-1",
      kind: "card-description",
      entityId: "card-1",
      cardId: "card-1",
      markdown: "Draft",
      baseMarkdown: "Base",
    });

    expect(drafts.load("user-1", "card-description", "card-1")).toEqual(expect.objectContaining({
      key: "card-description:user-1:card-1",
      markdown: "Draft",
      baseMarkdown: "Base",
      cardId: "card-1",
    }));

    drafts.clear("user-1", "card-description", "card-1");

    expect(drafts.load("user-1", "card-description", "card-1")).toBeNull();
  });

  it("ignores unchanged drafts", () => {
    drafts.save({
      userId: "user-1",
      kind: "comment-new",
      entityId: "card-1",
      markdown: "Same\n",
      baseMarkdown: "Same",
    });

    expect(drafts.load("user-1", "comment-new", "card-1")).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.EDITOR_DRAFTS)).toBeNull();
  });

  it("prunes drafts older than thirty days", () => {
    const fresh = {
      key: "note-body:user-1:note-1",
      userId: "user-1",
      kind: "note-body",
      entityId: "note-1",
      markdown: "Fresh",
      baseMarkdown: "",
      updatedAt: new Date("2026-06-01T00:00:00.000Z").toISOString(),
    };
    const stale = {
      key: "note-body:user-1:note-2",
      userId: "user-1",
      kind: "note-body",
      entityId: "note-2",
      markdown: "Stale",
      baseMarkdown: "",
      updatedAt: new Date("2026-04-01T00:00:00.000Z").toISOString(),
    };
    localStorage.setItem(STORAGE_KEYS.EDITOR_DRAFTS, JSON.stringify({ [fresh.key]: fresh, [stale.key]: stale }));

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T00:00:00.000Z"));
    try {
      expect(drafts.load("user-1", "note-body", "note-1")).toEqual(expect.objectContaining({ markdown: "Fresh" }));
      expect(drafts.load("user-1", "note-body", "note-2")).toBeNull();
      expect(Object.keys(JSON.parse(localStorage.getItem(STORAGE_KEYS.EDITOR_DRAFTS) ?? "{}"))).toEqual([fresh.key]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("handles invalid JSON and storage write failures", () => {
    localStorage.setItem(STORAGE_KEYS.EDITOR_DRAFTS, "{");

    expect(drafts.load("user-1", "card-description", "card-1")).toBeNull();

    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    expect(() => drafts.save({
      userId: "user-1",
      kind: "card-description",
      entityId: "card-1",
      markdown: "Draft",
      baseMarkdown: "",
    })).not.toThrow();
    setItem.mockRestore();
  });
});
