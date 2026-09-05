import { TestBed } from "@angular/core/testing";
import { provideZonelessChangeDetection } from "@angular/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeyboardShortcutsService, formatShortcut } from "./keyboard-shortcuts.service";

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe("KeyboardShortcutsService", () => {
  let service: KeyboardShortcutsService;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    service = TestBed.inject(KeyboardShortcutsService);
    service.attach();
  });

  afterEach(() => {
    service.detach();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("runs a bare key and prevents its default", () => {
    const run = vi.fn();
    service.register({ keys: "c", label: "New card", group: "Board", run });
    const event = press("c");
    expect(run).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it("stands down for bare keys inside inputs but not for modifier chords", () => {
    const bare = vi.fn();
    const chord = vi.fn();
    service.register({ keys: "c", label: "New card", group: "Board", run: bare });
    service.register({ keys: "mod+k", label: "Search", group: "Global", run: chord });
    const input = document.createElement("input");
    document.body.append(input);
    press("c", {}, input);
    press("k", { ctrlKey: true, metaKey: false }, input);
    press("k", { metaKey: true, ctrlKey: false }, input);
    expect(bare).not.toHaveBeenCalled();
    expect(chord).toHaveBeenCalledOnce();
  });

  it("completes a two-key sequence and forgets it after the timeout", () => {
    vi.useFakeTimers();
    const run = vi.fn();
    service.register({ keys: "g h", label: "Home", group: "Go to", run });
    press("g");
    press("h");
    expect(run).toHaveBeenCalledOnce();

    press("g");
    vi.advanceTimersByTime(1300);
    press("h");
    expect(run).toHaveBeenCalledOnce();
  });

  it("lets the newest registration win and honours `when`", () => {
    const board = vi.fn();
    const card = vi.fn();
    service.register({ keys: "a", label: "Board thing", group: "Board", run: board });
    const off = service.register({ keys: "a", label: "Assign", group: "Card", run: card, when: () => true });
    press("a");
    expect(card).toHaveBeenCalledOnce();
    expect(board).not.toHaveBeenCalled();

    off();
    press("a");
    expect(board).toHaveBeenCalledOnce();
  });

  it("formats chords and sequences for display", () => {
    expect(formatShortcut("g h")).toEqual([["G"], ["H"]]);
    expect(formatShortcut("?")).toEqual([["?"]]);
    expect(formatShortcut("mod+k")[0].at(-1)).toBe("K");
  });
});
