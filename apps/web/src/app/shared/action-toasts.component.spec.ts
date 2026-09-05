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
});
