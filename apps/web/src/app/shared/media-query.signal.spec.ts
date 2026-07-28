import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mediaQuerySignal } from "./media-query.signal";

type Listener = (event: MediaQueryListEvent) => void;

/** Minimal MediaQueryList stub: jsdom's own always reports `matches: false` and cannot be flipped. */
function stubMatchMedia(matches: boolean) {
  const listeners = new Set<Listener>();
  const mql = {
    matches,
    addEventListener: vi.fn((_type: string, listener: Listener) => listeners.add(listener)),
    removeEventListener: vi.fn((_type: string, listener: Listener) => listeners.delete(listener)),
  };
  const original = window.matchMedia;
  Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: () => mql });
  return {
    mql,
    emit(next: boolean) {
      for (const listener of listeners) listener({ matches: next } as MediaQueryListEvent);
    },
    restore() {
      Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: original });
    },
  };
}

describe("mediaQuerySignal", () => {
  let restore: (() => void) | null = null;

  afterEach(() => {
    restore?.();
    restore = null;
    TestBed.resetTestingModule();
  });

  it("starts at the current match and follows change events", () => {
    const media = stubMatchMedia(true);
    restore = media.restore;
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });

    const narrow = TestBed.runInInjectionContext(() => mediaQuerySignal("(max-width: 640px)"));
    expect(narrow()).toBe(true);

    media.emit(false);
    expect(narrow()).toBe(false);
  });

  it("detaches its listener when the injection context is destroyed", () => {
    const media = stubMatchMedia(false);
    restore = media.restore;
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });

    TestBed.runInInjectionContext(() => mediaQuerySignal("(max-width: 640px)"));
    expect(media.mql.removeEventListener).not.toHaveBeenCalled();

    TestBed.resetTestingModule();
    expect(media.mql.removeEventListener).toHaveBeenCalledTimes(1);
  });

  it("reports no match where matchMedia is unavailable", () => {
    const original = window.matchMedia;
    Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: undefined });
    restore = () => Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: original });
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });

    const narrow = TestBed.runInInjectionContext(() => mediaQuerySignal("(max-width: 640px)"));
    expect(narrow()).toBe(false);
  });
});
