import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnreadGlowDirective } from "./unread-glow.directive";

describe("UnreadGlowDirective", () => {
  let glow: UnreadGlowDirective;
  let motion: EventTarget & { matches: boolean };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    motion = Object.assign(new EventTarget(), { matches: false });
    vi.stubGlobal("matchMedia", () => motion);
    glow = new UnreadGlowDirective();
    glow.ngOnInit();
  });

  afterEach(() => {
    glow.ngOnDestroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("pulses for four seconds with no animation for the next 26 seconds", () => {
    expect(glow.pulsing()).toBe(true);
    vi.advanceTimersByTime(4_000);
    expect(glow.pulsing()).toBe(false);
    vi.advanceTimersByTime(25_999);
    expect(glow.pulsing()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(glow.pulsing()).toBe(true);
  });

  it("cancels all work while hidden and resumes when visible", () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(glow.pulsing()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(glow.pulsing()).toBe(true);
  });

  it("cancels work for reduced motion and when the badge is destroyed", () => {
    motion.matches = true;
    motion.dispatchEvent(new Event("change"));
    expect(glow.pulsing()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    motion.matches = false;
    motion.dispatchEvent(new Event("change"));
    expect(glow.pulsing()).toBe(true);
    glow.ngOnDestroy();
    expect(vi.getTimerCount()).toBe(0);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(glow.pulsing()).toBe(false);
  });
});
