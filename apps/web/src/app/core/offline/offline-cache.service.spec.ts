import * as fakeIDB from "fake-indexeddb";
import { IDBFactory, IDBKeyRange, IDBObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WireCardDetail, WireNote } from "@kanera/shared/events";
import { OfflineCacheService, type OfflineBoardSnapshot } from "./offline-cache.service";

function detail(id: string): WireCardDetail {
  return { card: { id, boardId: "board-1", title: id } } as WireCardDetail;
}
function board(title = "Before"): Omit<OfflineBoardSnapshot, "boardId" | "cachedAt"> {
  return { board: { id: "board-1", name: title }, cards: [detail("a").card, detail("b").card], detailedCards: [], customFieldValuesComplete: false } as unknown as Omit<OfflineBoardSnapshot, "boardId" | "cachedAt">;
}

describe("offline storage", () => {
  beforeEach(() => {
    for (const [key, value] of Object.entries(fakeIDB)) { if (key.startsWith("IDB")) vi.stubGlobal(key, value); }
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("upgrades version-9 snapshots without discarding their offline content", async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("kanera-offline", 9);
      request.onupgradeneeded = () => {
        for (const store of ["shell", "boards", "cardDetails", "notes", "globalWork", "homeToday"]) request.result.createObjectStore(store);
        request.transaction!.objectStore("boards").put({ ...board(), boardId: "board-1", cachedAt: new Date().toISOString() }, "board-1");
      };
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error ?? new Error("Could not open legacy cache"));
    });
    const cache = new OfflineCacheService();
    expect((await cache.loadBoard("board-1"))?.board.name).toBe("Before");
    await cache.saveCardDetail("a", detail("a"), []);
    expect((await cache.loadBoard("board-1"))?.detailedCards).toHaveLength(1);
  });

  it("keeps newer board data and both details during concurrent saves", async () => {
    const cache = new OfflineCacheService();
    await cache.saveBoard("board-1", board());
    await Promise.all([
      cache.saveCardDetail("a", detail("a"), []),
      cache.saveBoard("board-1", board("After")),
      cache.saveCardDetail("b", detail("b"), []),
    ]);
    const restored = await cache.loadBoard("board-1");
    expect(restored?.board.name).toBe("After");
    expect(restored?.detailedCards.map((row) => row.card.id).sort()).toEqual(["a", "b"]);
    expect(restored?.customFieldValuesComplete).toBe(false);
  });

  it("does not mark a whole board fresh when only its activity is refreshed", async () => {
    const cache = new OfflineCacheService();
    await cache.saveBoard("board-1", board());
    const before = await cache.loadBoard("board-1");
    await cache.saveCardDetail("a", detail("a"), []);
    expect((await cache.loadBoard("board-1"))?.cachedAt).toBe(before?.cachedAt);
  });

  it("evicts older data to keep the cache within its byte budget", async () => {
    const cache = new OfflineCacheService();
    const large = { ...board(), padding: "x".repeat(6 * 1024 * 1024) };
    await cache.saveBoard("old", large);
    await cache.saveBoard("middle", large);
    await cache.saveBoard("new", large);
    expect(await cache.loadBoard("old")).toBeNull();
    expect(await cache.loadBoard("new")).not.toBeNull();
  });

  it("retries a quota failure after eviction and reports persistent failures", async () => {
    const cache = new OfflineCacheService();
    await cache.saveBoard("old", board());
    const put = IDBObjectStore.prototype.put;
    let remainingFailures = 1;
    const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof put>) {
      if (this.name === "boards" && remainingFailures-- > 0) throw new DOMException("full", "QuotaExceededError");
      return put.apply(this, args);
    });
    await cache.saveBoard("new", board());
    expect(cache.persistenceError()).toBeNull();
    expect(await cache.loadBoard("new")).not.toBeNull();
    remainingFailures = 3;
    await expect(cache.saveBoard("failed", board())).rejects.toThrow("full");
    expect(cache.persistenceError()).toContain("could not be updated");
    spy.mockRestore();
  });
});

// Failure modes that a browser flow cannot reliably force: upgrading an already populated old
// IndexedDB version; a second tab replacing a manifest; eviction between two saves of the same
// object; a quota retry removing a manifest and its bodies. These storage-level assertions retain
// complete snapshot atomicity and privacy while proving unchanged bodies are not cloned again.
describe("normalized offline notes", () => {
  beforeEach(() => {
    for (const [key, value] of Object.entries(fakeIDB)) if (key.startsWith("IDB")) vi.stubGlobal(key, value);
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const note = (id: string, content = "Complete offline content"): WireNote => ({
    id, workspaceId: "workspace-1", boardId: null, title: id, content,
  }) as WireNote;

  it("writes only the changed body and restores every unchanged document in order", async () => {
    const cache = new OfflineCacheService();
    const first = note("first");
    const second = note("second");
    await cache.saveNotes("workspace-1", null, [first, second]);
    const put = vi.spyOn(IDBObjectStore.prototype, "put");
    const changed = { ...first, title: "Renamed" };
    await Promise.all([
      cache.saveNotes("workspace-1", null, [changed, second]),
      cache.saveNotes("workspace-1", null, [changed, second]),
    ]);
    const bodyWrites = put.mock.contexts.filter((store) => (store as IDBObjectStore).name === "noteEntries");
    expect(bodyWrites).toHaveLength(1);
    expect((await cache.loadNotes("workspace-1", null))?.notes).toEqual([changed, second]);
    await cache.saveNotes("workspace-1", null, [second]);
    expect((await cache.loadNotes("workspace-1", null))?.notes).toEqual([second]);
  });

  it("does not mistake a memoized body for one preserved after another tab writes", async () => {
    const firstTab = new OfflineCacheService();
    const secondTab = new OfflineCacheService();
    const original = note("first");
    await firstTab.saveNotes("workspace-1", null, [original]);
    await secondTab.saveNotes("workspace-1", null, [{ ...original, title: "Other tab" }]);
    await firstTab.saveNotes("workspace-1", null, [original]);
    expect((await secondTab.loadNotes("workspace-1", null))?.notes).toEqual([original]);
    await firstTab.clearAll();
    await firstTab.saveNotes("workspace-1", null, [original]);
    expect((await firstTab.loadNotes("workspace-1", null))?.notes).toEqual([original]);
  });

  it("retains legacy complete snapshots and atomically converts their next update", async () => {
    const original = note("legacy");
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("kanera-offline", 9);
      request.onupgradeneeded = () => {
        for (const store of ["shell", "boards", "cardDetails", "notes", "globalWork", "homeToday"]) request.result.createObjectStore(store);
        request.transaction!.objectStore("notes").put({ key: "workspace-1:workspace", cachedAt: new Date().toISOString(), workspaceId: "workspace-1", boardId: null, notes: [original] }, "workspace-1:workspace");
      };
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error ?? new Error("Could not open legacy notes cache"));
    });
    const cache = new OfflineCacheService();
    expect((await cache.loadNotes("workspace-1", null))?.notes).toEqual([original]);
    const changed = { ...original, title: "Converted" };
    await cache.saveNotes("workspace-1", null, [changed]);
    expect((await cache.loadNotes("workspace-1", null))?.notes).toEqual([changed]);
  });

  it("revokes and evicts complete trees without leaving note bodies behind", async () => {
    const cache = new OfflineCacheService();
    const first = { ...note("private"), boardId: "board-1" };
    await cache.saveNotes("workspace-1", "board-1", [first]);
    await cache.revokeBoardAccess("board-1");
    expect(await cache.loadNotes("workspace-1", "board-1")).toBeNull();
    const removed = vi.spyOn(IDBObjectStore.prototype, "delete");
    await cache.saveNotes("workspace-1", null, [note("large", "x".repeat(6 * 1024 * 1024))]);
    await cache.saveBoard("middle", { ...board(), padding: "x".repeat(6 * 1024 * 1024) } as unknown as Omit<OfflineBoardSnapshot, "boardId" | "cachedAt">);
    await cache.saveBoard("latest", { ...board(), padding: "x".repeat(6 * 1024 * 1024) } as unknown as Omit<OfflineBoardSnapshot, "boardId" | "cachedAt">);
    expect(await cache.loadNotes("workspace-1", null)).toBeNull();
    expect(removed.mock.contexts.some((store) => (store as IDBObjectStore).name === "noteEntries")).toBe(true);
  });
});
