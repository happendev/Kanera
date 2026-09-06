import * as fakeIDB from "fake-indexeddb";
import { IDBFactory, IDBKeyRange, IDBObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WireCardDetail } from "@kanera/shared/events";
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
