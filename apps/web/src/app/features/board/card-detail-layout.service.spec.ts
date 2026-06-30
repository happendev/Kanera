import { TestBed } from "@angular/core/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE_KEYS } from "../../core/browser/browser-contracts";
import { CardDetailLayoutService } from "./card-detail-layout.service";

describe("CardDetailLayoutService", () => {
  const originalMatchMedia = window.matchMedia;

  // Mock matchMedia so we can drive the below-lg state and fire the change
  // event the service listens to. `matches` seeds the initial state.
  function mockViewport(matches: boolean) {
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    Object.defineProperty(window, "matchMedia", {
      value: vi.fn(() => ({
        matches,
        addEventListener: (_type: string, cb: (event: MediaQueryListEvent) => void) => listeners.add(cb),
        removeEventListener: (_type: string, cb: (event: MediaQueryListEvent) => void) => listeners.delete(cb),
      })),
      configurable: true,
    });
    return (next: boolean) => listeners.forEach((cb) => cb({ matches: next } as MediaQueryListEvent));
  }

  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEYS.CARD_DETAIL_MODE);
    mockViewport(false);
    TestBed.resetTestingModule();
  });

  afterEach(() => {
    Object.defineProperty(window, "matchMedia", { value: originalMatchMedia, configurable: true });
  });

  it("uses the stored card detail mode on startup", () => {
    localStorage.setItem(STORAGE_KEYS.CARD_DETAIL_MODE, "modal");

    const service = TestBed.inject(CardDetailLayoutService);

    expect(service.mode()).toBe("modal");
  });

  it("updates when another tab changes the card detail mode", () => {
    const service = TestBed.inject(CardDetailLayoutService);

    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEYS.CARD_DETAIL_MODE, newValue: "modal" }));

    expect(service.mode()).toBe("modal");
  });

  it("falls back to panel when another tab clears the card detail mode", () => {
    localStorage.setItem(STORAGE_KEYS.CARD_DETAIL_MODE, "modal");
    const service = TestBed.inject(CardDetailLayoutService);

    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEYS.CARD_DETAIL_MODE, newValue: null }));

    expect(service.mode()).toBe("panel");
  });

  it("forces modal and hides the toggle below lg, even with panel stored", () => {
    localStorage.setItem(STORAGE_KEYS.CARD_DETAIL_MODE, "panel");
    mockViewport(true);

    const service = TestBed.inject(CardDetailLayoutService);

    expect(service.mode()).toBe("panel");
    expect(service.effectiveMode()).toBe("modal");
    expect(service.canToggle()).toBe(false);
  });

  it("offers the toggle and honors the stored mode at lg and above", () => {
    localStorage.setItem(STORAGE_KEYS.CARD_DETAIL_MODE, "panel");
    mockViewport(false);

    const service = TestBed.inject(CardDetailLayoutService);

    expect(service.effectiveMode()).toBe("panel");
    expect(service.canToggle()).toBe(true);
  });

  it("reacts to crossing the lg boundary", () => {
    const setBelowLg = mockViewport(false);
    const service = TestBed.inject(CardDetailLayoutService);

    expect(service.canToggle()).toBe(true);

    setBelowLg(true);

    expect(service.effectiveMode()).toBe("modal");
    expect(service.canToggle()).toBe(false);
  });

  it("ignores toggle attempts below lg so the preference is not flipped", () => {
    localStorage.setItem(STORAGE_KEYS.CARD_DETAIL_MODE, "panel");
    mockViewport(true);
    const service = TestBed.inject(CardDetailLayoutService);

    service.toggle();

    expect(service.mode()).toBe("panel");
    expect(localStorage.getItem(STORAGE_KEYS.CARD_DETAIL_MODE)).toBe("panel");
  });
});
