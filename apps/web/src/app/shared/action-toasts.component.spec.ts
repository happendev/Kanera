import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionToastService } from "./action-toast.service";
import { ActionToastsComponent } from "./action-toasts.component";

describe("ActionToastsComponent", () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  it("stacks confirmations and dismisses each independently by click or timeout", () => {
    vi.useFakeTimers();
    const fixture = TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    }).createComponent(ActionToastsComponent);
    const service = TestBed.inject(ActionToastService);
    service.success("Cards archived.", "archive");
    vi.advanceTimersByTime(1000);
    service.success("Cards moved.", "arrows-transfer-down");
    fixture.detectChanges();
    const panes = [...document.querySelectorAll<HTMLElement>(".cdk-overlay-pane")];
    expect(panes).toHaveLength(2);
    expect(new Set(panes.map((pane) => pane.style.marginBottom)).size).toBe(2);
    document.querySelector<HTMLButtonElement>('button[aria-label="Dismiss notification"]')!.click();
    fixture.detectChanges();
    expect(service.messages().map((toast) => toast.message)).toEqual(["Cards moved."]);
    vi.advanceTimersByTime(5000);
    expect(service.messages()).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    fixture.detectChanges();
    expect(document.querySelector(".status-toast")).toBeNull();
  });

  it("renders an Undo button that reverses the action and skips the deferred commit", async () => {
    vi.useFakeTimers();
    const fixture = TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    }).createComponent(ActionToastsComponent);
    const service = TestBed.inject(ActionToastService);
    const undo = vi.fn();
    const commit = vi.fn();
    service.undoable({ message: "Label deleted.", icon: "trash", undo, commit });
    fixture.detectChanges();
    const button = [...document.querySelectorAll<HTMLButtonElement>(".status-toast button")].find((el) => el.textContent?.trim() === "Undo");
    expect(button).toBeDefined();
    button!.click();
    await Promise.resolve();
    fixture.detectChanges();
    expect(undo).toHaveBeenCalledTimes(1);
    expect(service.messages()).toEqual([]);
    vi.advanceTimersByTime(10000);
    expect(commit).not.toHaveBeenCalled();
  });

  it("commits a deferred action on expiry, on dismiss, and on pagehide", async () => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    const service = TestBed.inject(ActionToastService);
    const expired = vi.fn();
    const dismissed = vi.fn();
    const hidden = vi.fn();
    service.undoable({ message: "a", icon: "trash", undo: () => undefined, commit: expired });
    const dismissId = service.undoable({ message: "b", icon: "trash", undo: () => undefined, commit: dismissed });
    service.dismiss(dismissId);
    expect(dismissed).toHaveBeenCalledTimes(1);
    expect(expired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(6000);
    expect(expired).toHaveBeenCalledTimes(1);
    service.undoable({ message: "c", icon: "trash", undo: () => undefined, commit: hidden });
    window.dispatchEvent(new Event("pagehide"));
    expect(hidden).toHaveBeenCalledTimes(1);
    expect(service.messages()).toEqual([]);
  });

  it("reports a failed undo as a neutral toast", async () => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    const service = TestBed.inject(ActionToastService);
    service.undoable({ message: "Card archived.", icon: "archive", undo: () => Promise.reject(new Error("nope")) });
    service.messages()[0]!.action!.run();
    await Promise.resolve();
    await Promise.resolve();
    expect(service.messages().map((toast) => [toast.success, toast.message])).toEqual([[false, "Couldn't undo that. Refresh to see the current state."]]);
  });
});
