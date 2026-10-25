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

  it("opens `?` however the layout reports Shift+/ and keeps it away from a bare `/`", () => {
    const search = vi.fn();
    const help = vi.fn();
    service.register({ keys: "/", label: "Search", group: "Board", run: search });
    service.register({ keys: "?", label: "Help", group: "Everywhere", run: help });

    press("?", { shiftKey: true });
    press("/", { shiftKey: true });
    expect(help).toHaveBeenCalledTimes(2);
    expect(search).not.toHaveBeenCalled();

    press("/");
    expect(search).toHaveBeenCalledOnce();
    expect(help).toHaveBeenCalledTimes(2);
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

  // Modifier/layout combinations and sequence teardown are dispatcher edge cases: exercise the
  // exact KeyboardEvent shapes here without depending on the browser host's keyboard layout/timing.
  it("does not turn unavailable redo into undo or accept extra Shift on other commands", () => {
    const undo = vi.fn();
    const redo = vi.fn();
    const title = vi.fn();
    const complete = vi.fn();
    const mod = formatShortcut("mod")[0][0] === "⌘" ? { metaKey: true } : { ctrlKey: true };
    service.register({ keys: "mod+z", label: "Undo", group: "Map", run: undo });
    service.register({ keys: "mod+shift+z", label: "Redo", group: "Map", when: () => false, run: redo });
    service.register({ keys: "e", label: "Title", group: "Card", run: title });
    service.register({ keys: "mod+enter", label: "Complete", group: "Card", run: complete });

    expect(press("Z", { ...mod, shiftKey: true }).defaultPrevented).toBe(false);
    press("E", { shiftKey: true });
    press("Enter", { ...mod, shiftKey: true });
    expect(undo).not.toHaveBeenCalled();
    expect(redo).not.toHaveBeenCalled();
    expect(title).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    press("z", mod);
    expect(undo).toHaveBeenCalledOnce();
  });

  it("preserves literal symbols and digits that require Shift on a keyboard layout", () => {
    const help = vi.fn();
    const view = vi.fn();
    const scratchpad = vi.fn();
    const mod = formatShortcut("mod")[0][0] === "⌘" ? { metaKey: true } : { ctrlKey: true };
    service.register({ keys: "?", label: "Help", group: "Global", run: help });
    service.register({ keys: "1", label: "Board", group: "Board", run: view });
    service.register({ keys: "mod+shift+.", label: "Scratchpad", group: "Global", run: scratchpad });
    press("?");
    press("1", { shiftKey: true });
    press(">", { ...mod, shiftKey: true });
    press(".", { ...mod, shiftKey: true });
    expect(help).toHaveBeenCalledOnce();
    expect(view).toHaveBeenCalledOnce();
    expect(scratchpad).toHaveBeenCalledTimes(2);
  });

  it("drops pending sequences when their registration goes away", () => {
    const run = vi.fn();
    const off = service.register({ keys: "g h", label: "Home", group: "Go to", run });
    press("g");
    off();
    press("h");
    expect(run).not.toHaveBeenCalled();
  });

  it("formats chords and sequences for display", () => {
    expect(formatShortcut("g h")).toEqual([["G"], ["H"]]);
    expect(formatShortcut("?")).toEqual([["?"]]);
    expect(formatShortcut("mod+k")[0].at(-1)).toBe("K");
  });
});
