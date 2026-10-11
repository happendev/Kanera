import { signal } from "@angular/core";

/** Replacement-array writes must build on the latest click, not a delayed realtime echo. */
export class PendingCustomFieldIds {
  private readonly pending = signal(new Map<string, string[]>());
  private readonly tails = new Map<string, Promise<void>>();

  value(key: string, stored: string[]): string[] {
    return this.pending().get(key) ?? stored;
  }

  write(key: string, ids: string[], save: (ids: string[]) => Promise<void>): Promise<void> {
    const next = [...ids];
    this.pending.update((values) => new Map(values).set(key, next));
    const previous = this.tails.get(key);
    // Keep requests ordered because PUT replaces the entire array. A failed earlier request must
    // not cancel a later selection, which already contains the user's complete desired value.
    const request = (previous ? previous.catch(() => undefined) : Promise.resolve())
      .then(() => save(next))
      .finally(() => {
        if (this.tails.get(key) !== request) return;
        this.tails.delete(key);
        // The host merges the response into its authoritative store before releasing this overlay.
        this.pending.update((values) => {
          const remaining = new Map(values);
          remaining.delete(key);
          return remaining;
        });
      });
    this.tails.set(key, request);
    return request;
  }
}
