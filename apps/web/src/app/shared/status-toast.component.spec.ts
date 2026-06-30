import { ChangeDetectionStrategy, Component, provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it, vi, afterEach } from "vitest";
import { StatusToastComponent } from "./status-toast.component";

@Component({
  standalone: true,
  imports: [StatusToastComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <k-status-toast [show]="first()" icon="wifi-off" message="You're offline - reconnecting..." />
    <k-status-toast [show]="second()" icon="cloud-off" message="Offline copy from just now" />
  `,
})
class ToastStackHostComponent {
  readonly first = signal(true);
  readonly second = signal(true);
}

describe("StatusToastComponent", () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
    document.querySelectorAll(".cdk-overlay-container").forEach((el) => el.remove());
  });

  it("delays showing and suppresses quick flashes", () => {
    vi.useFakeTimers();
    const show = signal(false);
    const fixture = TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    }).createComponent(StatusToastComponent);
    fixture.componentRef.setInput("show", show());
    fixture.componentRef.setInput("delayMs", 3000);
    fixture.componentRef.setInput("icon", "cloud-off");
    fixture.componentRef.setInput("message", "Offline copy from just now");
    fixture.detectChanges();

    show.set(true);
    fixture.componentRef.setInput("show", show());
    fixture.detectChanges();

    vi.advanceTimersByTime(2999);
    fixture.detectChanges();
    expect(document.querySelector(".status-toast")).toBeNull();

    vi.advanceTimersByTime(1);
    fixture.detectChanges();
    expect(document.querySelector(".status-toast .message")?.textContent?.trim()).toBe("Offline copy from just now");

    show.set(false);
    fixture.componentRef.setInput("show", show());
    fixture.detectChanges();
    expect(document.querySelector(".status-toast")).toBeNull();

    show.set(true);
    fixture.componentRef.setInput("show", show());
    fixture.detectChanges();
    vi.advanceTimersByTime(1000);
    show.set(false);
    fixture.componentRef.setInput("show", show());
    fixture.detectChanges();
    vi.advanceTimersByTime(3000);
    fixture.detectChanges();

    expect(document.querySelector(".status-toast")).toBeNull();
    fixture.destroy();
  });

  it("stacks visible toasts at distinct bottom positions", () => {
    const fixture = TestBed.configureTestingModule({
      imports: [ToastStackHostComponent],
      providers: [provideZonelessChangeDetection()],
    }).createComponent(ToastStackHostComponent);
    fixture.detectChanges();

    const panes = [...document.querySelectorAll<HTMLElement>(".cdk-overlay-pane")];
    expect(panes).toHaveLength(2);

    const bottomOffsets = panes.map((pane) => pane.style.marginBottom);
    expect(new Set(bottomOffsets).size).toBe(2);
    expect(bottomOffsets).toContain("16px");
    expect(bottomOffsets).toContain("68px");

    fixture.componentInstance.first.set(false);
    fixture.detectChanges();

    const visibleToast = document.querySelector<HTMLElement>(".cdk-overlay-pane .status-toast")?.closest<HTMLElement>(".cdk-overlay-pane");
    expect(visibleToast?.style.marginBottom).toBe("16px");
    fixture.destroy();
  });
});
