import { DestroyRef, Injectable, inject } from "@angular/core";
import type { CardFeedItem, WireCardDetail } from "@kanera/shared/events";
import { OfflineCacheService } from "../../core/offline/offline-cache.service";

type Snapshot = { detail?: WireCardDetail; feed?: CardFeedItem[] };

/**
 * One writer for the independently loaded detail and feed. Provided by CardDetailComponent, so
 * the debounce, the flush on destroy and the per-card memory follow that one drawer.
 */
@Injectable()
export class CardDetailPersistence {
  private readonly cache = inject(OfflineCacheService);
  private readonly latest = new Map<string, Snapshot>();
  private readonly pending = new Map<string, Snapshot>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writes = Promise.resolve();

  constructor() {
    const hidden = () => { if (document.visibilityState === "hidden") void this.flush(); };
    document.addEventListener("visibilitychange", hidden);
    inject(DestroyRef).onDestroy(() => {
      document.removeEventListener("visibilitychange", hidden);
      void this.flush();
    });
  }

  schedule(cardId: string, snapshot: Snapshot) {
    // Feed can finish before a slow first detail load. Retain it across an otherwise empty flush
    // so the later detail write still contains those comments instead of persisting an empty feed.
    const latest = { ...this.latest.get(cardId), ...snapshot };
    this.latest.set(cardId, latest);
    this.pending.set(cardId, latest);
    clearTimeout(this.timer);
    if (document.visibilityState === "hidden") void this.flush();
    else this.timer = setTimeout(() => void this.flush(), 150);
  }

  closeCard(cardId: string): Promise<void> {
    const write = this.flush();
    this.latest.delete(cardId);
    return write;
  }

  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const pending = [...this.pending];
    this.pending.clear();
    // Serialize read/merge/write across flushes: a slow IndexedDB read from an earlier burst must
    // never overwrite a newer feed or detail, including when close flushes an already active write.
    this.writes = this.writes.then(async () => {
      for (const [cardId, snapshot] of pending) {
        try {
          const cached = snapshot.detail && snapshot.feed ? null : await this.cache.loadCardDetail(cardId);
          const detail = snapshot.detail ?? cached?.detail;
          if (detail) await this.cache.saveCardDetail(cardId, detail, snapshot.feed ?? cached?.feed ?? []);
        } catch { /* Offline caching is best effort; never interrupt a live editor. */ }
      }
    });
    return this.writes;
  }
}
