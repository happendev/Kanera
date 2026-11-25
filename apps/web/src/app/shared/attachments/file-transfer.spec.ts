import { provideZonelessChangeDetection, type WritableSignal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileDragActiveSignal } from "./file-transfer";

// A drag from the OS file manager that is cancelled or carried out of the window never reaches the
// drop zone's own drop/dragleave handlers, so these cover the ways the flag must still reset.
describe("fileDragActiveSignal", () => {
  let active: WritableSignal<boolean>;

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    active = TestBed.runInInjectionContext(() => fileDragActiveSignal());
    active.set(true);
    TestBed.tick();
  });

  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  function fire(type: string, init: { relatedTarget?: EventTarget | null } = {}) {
    const event = new Event(type, { bubbles: true });
    Object.defineProperty(event, "relatedTarget", { value: init.relatedTarget ?? null });
    document.body.dispatchEvent(event);
  }

  it("clears when dragover stops arriving (drag cancelled over the page)", () => {
    vi.advanceTimersByTime(900);
    fire("dragover");
    vi.advanceTimersByTime(900);
    expect(active()).toBe(true);

    vi.advanceTimersByTime(200);
    expect(active()).toBe(false);
  });

  it("clears when the drag leaves the window", () => {
    fire("dragleave");
    expect(active()).toBe(false);
  });

  it("stays set while the drag crosses between elements, even with a null relatedTarget", () => {
    fire("dragenter");
    fire("dragleave");
    fire("dragleave", { relatedTarget: document.body });
    expect(active()).toBe(true);
  });

  it("clears on the first pointer event after the drag", () => {
    fire("pointermove");
    expect(active()).toBe(false);
  });

  it("stops listening once cleared", () => {
    fire("drop");
    expect(active()).toBe(false);
    TestBed.tick();

    active.set(true);
    fire("pointermove");
    expect(active()).toBe(true);
  });
});
