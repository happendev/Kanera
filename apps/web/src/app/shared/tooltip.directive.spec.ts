import { ChangeDetectionStrategy, Component, provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipDirective } from "./tooltip.directive";

@Component({
  standalone: true,
  imports: [TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      title="Native title"
      [kTooltip]="text()"
      [kTooltipDisabled]="disabled()"
      [kTooltipPosition]="position()">
      Target
    </button>
  `,
})
class TooltipHostComponent {
  readonly text = signal<string | null>("Helpful text");
  readonly disabled = signal(false);
  readonly position = signal<"top" | "right" | "bottom" | "left">("top");
}

describe("TooltipDirective", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.querySelectorAll(".cdk-overlay-container").forEach((el) => el.remove());
  });

  it("shows after the hover delay and removes the native title", () => {
    vi.useFakeTimers();
    const fixture = TestBed.configureTestingModule({
      imports: [TooltipHostComponent],
      providers: [provideZonelessChangeDetection()],
    }).createComponent(TooltipHostComponent);
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector("button") as HTMLButtonElement;
    expect(button.getAttribute("title")).toBeNull();

    button.dispatchEvent(new Event("mouseenter"));
    vi.advanceTimersByTime(299);
    expect(document.querySelector(".k-tooltip")).toBeNull();

    vi.advanceTimersByTime(1);
    fixture.detectChanges();

    expect(document.querySelector(".k-tooltip")?.textContent).toBe("Helpful text");
    expect(document.querySelector(".k-tooltip-panel")?.classList.contains("k-tooltip-panel-top")).toBe(true);
  });

  it("hides on mouse leave", () => {
    vi.useFakeTimers();
    const fixture = TestBed.configureTestingModule({
      imports: [TooltipHostComponent],
      providers: [provideZonelessChangeDetection()],
    }).createComponent(TooltipHostComponent);
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector("button") as HTMLButtonElement;
    button.dispatchEvent(new Event("mouseenter"));
    vi.advanceTimersByTime(300);
    expect(document.querySelector(".k-tooltip")).not.toBeNull();

    button.dispatchEvent(new Event("mouseleave"));
    fixture.detectChanges();

    expect(document.querySelector(".k-tooltip")).toBeNull();
    expect(button.hasAttribute("aria-describedby")).toBe(false);
  });

  it("auto-hides after 10 seconds while still hovered", () => {
    vi.useFakeTimers();
    const fixture = TestBed.configureTestingModule({
      imports: [TooltipHostComponent],
      providers: [provideZonelessChangeDetection()],
    }).createComponent(TooltipHostComponent);
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector("button") as HTMLButtonElement;
    button.dispatchEvent(new Event("mouseenter"));
    vi.advanceTimersByTime(300);
    fixture.detectChanges();
    expect(document.querySelector(".k-tooltip")).not.toBeNull();

    vi.advanceTimersByTime(9_999);
    fixture.detectChanges();
    expect(document.querySelector(".k-tooltip")).not.toBeNull();

    vi.advanceTimersByTime(1);
    fixture.detectChanges();

    expect(document.querySelector(".k-tooltip")).toBeNull();
    expect(button.hasAttribute("aria-describedby")).toBe(false);
  });

  it("shows on focus and wires aria-describedby while visible", () => {
    const fixture = TestBed.configureTestingModule({
      imports: [TooltipHostComponent],
      providers: [provideZonelessChangeDetection()],
    }).createComponent(TooltipHostComponent);
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector("button") as HTMLButtonElement;
    button.dispatchEvent(new FocusEvent("focusin"));
    fixture.detectChanges();

    const tooltip = document.querySelector(".k-tooltip") as HTMLElement | null;
    expect(tooltip?.id).toBeTruthy();
    expect(button.getAttribute("aria-describedby")).toBe(tooltip?.id);

    button.dispatchEvent(new FocusEvent("focusout"));
    fixture.detectChanges();

    expect(document.querySelector(".k-tooltip")).toBeNull();
    expect(button.hasAttribute("aria-describedby")).toBe(false);
  });

  it("suppresses empty and disabled tooltips", () => {
    vi.useFakeTimers();
    const fixture = TestBed.configureTestingModule({
      imports: [TooltipHostComponent],
      providers: [provideZonelessChangeDetection()],
    }).createComponent(TooltipHostComponent);
    fixture.componentInstance.text.set("");
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector("button") as HTMLButtonElement;
    button.dispatchEvent(new Event("mouseenter"));
    vi.advanceTimersByTime(300);
    expect(document.querySelector(".k-tooltip")).toBeNull();

    fixture.componentInstance.text.set("Helpful text");
    fixture.componentInstance.disabled.set(true);
    fixture.detectChanges();
    button.dispatchEvent(new Event("mouseenter"));
    vi.advanceTimersByTime(300);
    expect(document.querySelector(".k-tooltip")).toBeNull();
  });

  it("hides on Escape", () => {
    const fixture = TestBed.configureTestingModule({
      imports: [TooltipHostComponent],
      providers: [provideZonelessChangeDetection()],
    }).createComponent(TooltipHostComponent);
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector("button") as HTMLButtonElement;
    button.dispatchEvent(new FocusEvent("focusin"));
    fixture.detectChanges();
    expect(document.querySelector(".k-tooltip")).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    fixture.detectChanges();

    expect(document.querySelector(".k-tooltip")).toBeNull();
  });
});
