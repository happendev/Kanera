import { ChangeDetectionStrategy, Component, provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipDirective, resetTooltipWarmWindow } from "./tooltip.directive";

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

@Component({
  standalone: true,
  imports: [TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <a [kTooltip]="name" kTooltipTruncationTarget=".label">
      <span class="label">{{ name }}</span>
    </a>
  `,
})
class TruncationHostComponent {
  readonly name = "Quarterly Roadmap Planning";
}

describe("TooltipDirective", () => {
  afterEach(() => {
    resetTooltipWarmWindow();
    vi.useRealTimers();
    document.body.classList.remove("is-checklist-dragging");
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

  it("hides when a nested container scrolls", () => {
    const fixture = TestBed.configureTestingModule({
      imports: [TooltipHostComponent],
      providers: [provideZonelessChangeDetection()],
    }).createComponent(TooltipHostComponent);
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector("button") as HTMLButtonElement;
    button.dispatchEvent(new FocusEvent("focusin"));
    fixture.detectChanges();
    expect(document.querySelector(".k-tooltip")).not.toBeNull();

    fixture.nativeElement.dispatchEvent(new Event("scroll"));
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

  it("hides on Escape even when another document handler consumes the bubbling event", () => {
    const fixture = TestBed.configureTestingModule({
      imports: [TooltipHostComponent],
      providers: [provideZonelessChangeDetection()],
    }).createComponent(TooltipHostComponent);
    fixture.detectChanges();

    const consumeEscape = (event: KeyboardEvent) => event.stopImmediatePropagation();
    document.addEventListener("keydown", consumeEscape);
    const button = fixture.nativeElement.querySelector("button") as HTMLButtonElement;
    button.dispatchEvent(new FocusEvent("focusin"));
    fixture.detectChanges();
    const tooltipId = button.getAttribute("aria-describedby");
    expect(tooltipId).toBeTruthy();
    expect(document.getElementById(tooltipId!)).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    document.removeEventListener("keydown", consumeEscape);
    fixture.detectChanges();

    // Other specs can own overlays in the shared document; only this button's tooltip is in scope.
    expect(document.getElementById(tooltipId!)).toBeNull();
    expect(button.hasAttribute("aria-describedby")).toBe(false);
  });

  it("closes an open tooltip and suppresses new ones during a checklist drag", () => {
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

    document.body.classList.add("is-checklist-dragging");
    document.dispatchEvent(new CustomEvent("kanera:drag-start"));
    fixture.detectChanges();
    expect(document.querySelector(".k-tooltip")).toBeNull();

    button.dispatchEvent(new Event("mouseenter"));
    vi.advanceTimersByTime(300);
    expect(document.querySelector(".k-tooltip")).toBeNull();
  });
  it("with a truncation target, shows only while that element overflows", () => {
    vi.useFakeTimers();
    const fixture = TestBed.configureTestingModule({
      imports: [TruncationHostComponent],
      providers: [provideZonelessChangeDetection()],
    }).createComponent(TruncationHostComponent);
    fixture.detectChanges();

    const link = fixture.nativeElement.querySelector("a") as HTMLAnchorElement;
    const label = link.querySelector(".label") as HTMLSpanElement;
    // jsdom lays nothing out, so both extents read 0: the label fits and the tooltip must stay away.
    link.dispatchEvent(new Event("mouseenter"));
    vi.advanceTimersByTime(400);
    fixture.detectChanges();
    expect(document.querySelector(".k-tooltip")).toBeNull();

    link.dispatchEvent(new Event("mouseleave"));
    vi.advanceTimersByTime(400);
    Object.defineProperty(label, "scrollWidth", { value: 240, configurable: true });
    Object.defineProperty(label, "clientWidth", { value: 120, configurable: true });
    link.dispatchEvent(new Event("mouseenter"));
    vi.advanceTimersByTime(400);
    fixture.detectChanges();
    expect(document.querySelector(".k-tooltip")?.textContent).toBe("Quarterly Roadmap Planning");
  });
});
