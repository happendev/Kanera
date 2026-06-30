import { afterEach, describe, expect, it, vi } from "vitest";
import { vibrateCardDragEnd, vibrateCardDragStart } from "./haptics";

describe("card drag haptics", () => {
  const originalMatchMedia = window.matchMedia;
  const originalVibrate = navigator.vibrate;
  const originalMaxTouchPoints = navigator.maxTouchPoints;

  afterEach(() => {
    Object.defineProperty(window, "matchMedia", { value: originalMatchMedia, configurable: true });
    Object.defineProperty(navigator, "vibrate", { value: originalVibrate, configurable: true });
    Object.defineProperty(navigator, "maxTouchPoints", { value: originalMaxTouchPoints, configurable: true });
    vi.restoreAllMocks();
  });

  function setCoarsePointer(matches: boolean) {
    Object.defineProperty(window, "matchMedia", {
      value: vi.fn(() => ({ matches }) as MediaQueryList),
      configurable: true,
    });
  }

  it("does nothing when vibration is unavailable", () => {
    setCoarsePointer(true);
    Object.defineProperty(navigator, "vibrate", { value: undefined, configurable: true });

    expect(() => vibrateCardDragStart()).not.toThrow();
  });

  it("does not vibrate on non-touch pointer devices", () => {
    const vibrate = vi.fn();
    setCoarsePointer(false);
    Object.defineProperty(navigator, "maxTouchPoints", { value: 0, configurable: true });
    Object.defineProperty(navigator, "vibrate", { value: vibrate, configurable: true });

    vibrateCardDragStart();

    expect(vibrate).not.toHaveBeenCalled();
  });

  it("vibrates with the start pattern on coarse pointer devices", () => {
    const vibrate = vi.fn();
    setCoarsePointer(true);
    Object.defineProperty(navigator, "vibrate", { value: vibrate, configurable: true });

    vibrateCardDragStart();

    expect(vibrate).toHaveBeenCalledWith(12);
  });

  it("vibrates with the end pattern on touch-capable devices", () => {
    const vibrate = vi.fn();
    setCoarsePointer(false);
    Object.defineProperty(navigator, "maxTouchPoints", { value: 1, configurable: true });
    Object.defineProperty(navigator, "vibrate", { value: vibrate, configurable: true });

    vibrateCardDragEnd();

    expect(vibrate).toHaveBeenCalledWith([8, 24, 8]);
  });

  it("ignores browser vibration errors", () => {
    setCoarsePointer(true);
    Object.defineProperty(navigator, "vibrate", {
      value: vi.fn(() => {
        throw new Error("blocked");
      }),
      configurable: true,
    });

    expect(() => vibrateCardDragEnd()).not.toThrow();
  });
});
