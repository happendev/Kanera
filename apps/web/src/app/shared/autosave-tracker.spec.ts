import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTOSAVE_SAVED_VISIBLE_MS, AutosaveTracker } from "./autosave-tracker";

describe("AutosaveTracker", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows saving, then saved briefly, then returns to idle", async () => {
    vi.useFakeTimers();
    const tracker = new AutosaveTracker();
    const work = tracker.track(() => Promise.resolve("ok"));
    expect(tracker.state()).toBe("saving");
    await expect(work).resolves.toBe("ok");
    expect(tracker.state()).toBe("saved");
    vi.advanceTimersByTime(AUTOSAVE_SAVED_VISIBLE_MS);
    expect(tracker.state()).toBe("idle");
  });

  it("keeps a failure visible until the next attempt and rethrows for caller rollback", async () => {
    vi.useFakeTimers();
    const tracker = new AutosaveTracker();
    await expect(tracker.track(() => Promise.reject(new Error("nope")))).rejects.toThrow("nope");
    expect(tracker.state()).toBe("error");
    vi.advanceTimersByTime(60_000);
    expect(tracker.state()).toBe("error");
    // A save that lands after the previous "saved" timer is still pending must not be reset to idle early.
    await tracker.track(() => Promise.resolve());
    vi.advanceTimersByTime(AUTOSAVE_SAVED_VISIBLE_MS - 1);
    await tracker.track(() => Promise.resolve());
    vi.advanceTimersByTime(1);
    expect(tracker.state()).toBe("saved");
  });

  it("runs destroy through the DestroyRef it was given", () => {
    const callbacks: (() => void)[] = [];
    const destroyRef = { onDestroy: (cb: () => void) => { callbacks.push(cb); return () => undefined; } };
    const tracker = new AutosaveTracker(destroyRef as never);
    tracker.markSaved();
    callbacks.forEach((cb) => cb());
    tracker.reset();
    expect(tracker.state()).toBe("idle");
  });
});
