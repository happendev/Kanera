import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../core/api/api.client";
import { CardDetailRequest } from "./card-detail-request";

// An aborted transport can still settle later (cached response/mock). Force this order so its
// cleanup cannot clear the replacement request and admit another duplicate network load.
describe("card detail request ownership", () => {
  it("deduplicates active reads and keeps the replacement alive when an aborted read settles", async () => {
    const pending: { resolve: (value: string) => void; signal: AbortSignal }[] = [];
    const get = vi.fn((_path: string, init: { signal: AbortSignal }) => new Promise<string>((resolve) => {
      pending.push({ resolve, signal: init.signal });
    }));
    const reads = new CardDetailRequest({ get } as unknown as ApiClient);
    const first = reads.get<string>("/cards/a/detail");
    expect(reads.get("/cards/a/detail")).toBe(first);
    const second = reads.get<string>("/cards/b/detail");
    expect(pending[0]!.signal.aborted).toBe(true);
    pending[0]!.resolve("old");
    await first;
    expect(reads.get("/cards/b/detail")).toBe(second);
    expect(get).toHaveBeenCalledTimes(2);
    reads.cancel();
    expect(pending[1]!.signal.aborted).toBe(true);
    pending[1]!.resolve("new");
    await second;
  });
});
