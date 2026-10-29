import { TestBed } from "@angular/core/testing";
import type { CardFeedItem, WireCardDetail } from "@kanera/shared/events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OfflineCacheService } from "../../core/offline/offline-cache.service";
import { CardDetailPersistence } from "./card-detail-persistence.service";

// Deterministic timing failures: feed finishing before detail, an older IndexedDB read completing
// after a close flush, and browser visibility/destruction before the debounce deadline. E2E covers
// real event-burst coalescing; fake timers force these interleavings without machine timing races.
describe("card detail persistence lifecycle", () => {
  const detail = { card: { id: "card-1" } } as WireCardDetail;
  const feed = [{ type: "comment", data: { id: "comment-1" } }] as CardFeedItem[];
  let cache: { loadCardDetail: ReturnType<typeof vi.fn>; saveCardDetail: ReturnType<typeof vi.fn> };
  let persistence: CardDetailPersistence;
  beforeEach(() => {
    vi.useFakeTimers();
    cache = { loadCardDetail: vi.fn(async () => null), saveCardDetail: vi.fn(async () => undefined) };
    TestBed.configureTestingModule({ providers: [CardDetailPersistence, { provide: OfflineCacheService, useValue: cache }] });
    persistence = TestBed.inject(CardDetailPersistence);
  });
  afterEach(() => { TestBed.resetTestingModule(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it("retains a fast feed across a flush before first detail arrives", async () => {
    persistence.schedule("card-1", { feed });
    await vi.advanceTimersByTimeAsync(151);
    expect(cache.saveCardDetail).not.toHaveBeenCalled();
    persistence.schedule("card-1", { detail });
    await persistence.closeCard("card-1");
    expect(cache.saveCardDetail).toHaveBeenCalledExactlyOnceWith("card-1", detail, feed);
  });

  it("flushes pending data immediately when the page becomes hidden", async () => {
    persistence.schedule("card-1", { detail, feed });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await persistence.flush();
    expect(cache.saveCardDetail).toHaveBeenCalledExactlyOnceWith("card-1", detail, feed);
  });

  it("flushes on destruction before the debounce expires", async () => {
    persistence.schedule("card-1", { detail, feed });
    TestBed.resetTestingModule();
    await persistence.flush();
    expect(cache.saveCardDetail).toHaveBeenCalledExactlyOnceWith("card-1", detail, feed);
  });

  it("serializes close behind an older pending cache read", async () => {
    let release!: (value: null) => void;
    cache.loadCardDetail.mockReturnValueOnce(new Promise<null>((resolve) => { release = resolve; }));
    persistence.schedule("card-1", { detail });
    const earlier = persistence.flush();
    await Promise.resolve();
    const latest = { ...detail, revision: "2" };
    persistence.schedule("card-1", { detail: latest, feed });
    const closing = persistence.closeCard("card-1");
    expect(cache.saveCardDetail).not.toHaveBeenCalled();
    release(null);
    await Promise.all([earlier, closing]);
    expect(cache.saveCardDetail.mock.calls.at(-1)).toEqual(["card-1", latest, feed]);
  });
});
