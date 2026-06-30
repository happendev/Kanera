import { afterEach, describe, expect, it, vi } from "vitest";
import { cardDragEdgeScrollStep, MOBILE_EDGE_SCROLL_STEP } from "./card-drag-scroll";

describe("cardDragEdgeScrollStep", () => {
  const originalMatchMedia = window.matchMedia;
  const originalMaxTouchPoints = navigator.maxTouchPoints;

  afterEach(() => {
    Object.defineProperty(window, "matchMedia", { value: originalMatchMedia, configurable: true });
    Object.defineProperty(navigator, "maxTouchPoints", { value: originalMaxTouchPoints, configurable: true });
    vi.restoreAllMocks();
  });

  function setPointer(matches: boolean, maxTouchPoints = 0) {
    Object.defineProperty(window, "matchMedia", {
      value: vi.fn(() => ({ matches }) as MediaQueryList),
      configurable: true,
    });
    Object.defineProperty(navigator, "maxTouchPoints", { value: maxTouchPoints, configurable: true });
  }

  it("uses fixed steady speed near either edge on coarse pointer devices", () => {
    setPointer(true);

    expect(cardDragEdgeScrollStep(20, 400)).toBe(-MOBILE_EDGE_SCROLL_STEP);
    expect(cardDragEdgeScrollStep(390, 400)).toBe(MOBILE_EDGE_SCROLL_STEP);
  });

  it("keeps proportional edge speed on fine pointer devices", () => {
    setPointer(false);

    expect(cardDragEdgeScrollStep(92, 400)).toBe(-2);
    expect(cardDragEdgeScrollStep(399, 400)).toBe(28);
  });

  it("treats touch-capable devices as coarse when matchMedia is unavailable", () => {
    Object.defineProperty(window, "matchMedia", { value: undefined, configurable: true });
    Object.defineProperty(navigator, "maxTouchPoints", { value: 1, configurable: true });

    expect(cardDragEdgeScrollStep(399, 400)).toBe(MOBILE_EDGE_SCROLL_STEP);
  });

  it("does not scroll outside the edge threshold", () => {
    setPointer(true);

    expect(cardDragEdgeScrollStep(200, 400)).toBe(0);
  });
});
