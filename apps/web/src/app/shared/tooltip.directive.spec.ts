import { createComponentFixture } from "../../test/component-fixture";
import { OverlayContainer } from "@angular/cdk/overlay";
import { ChangeDetectionStrategy, Component, provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipDirective, resetTooltipTiming } from "./tooltip.directive";

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

function tooltipElement(): HTMLElement | null {
  // Other specs can leave overlays in the shared document. Assert against this fixture's service.
  return TestBed.inject(OverlayContainer).getContainerElement().querySelector<HTMLElement>(".k-tooltip");
}

describe("TooltipDirective", () => {
  beforeEach(() => {
    // Directive modules are shared across spec files; the first test must start cold too.
    resetTooltipTiming();
  });

  afterEach(() => {
    // Teardown can warm the hover window; destroy fixtures before resetting it and restoring timers.
    TestBed.resetTestingModule();
    resetTooltipTiming();
    vi.useRealTimers();
    document.body.classList.remove("is-checklist-dragging");
  });

  it("shows after the hover delay and removes the native title", () => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      imports: [TooltipHostComponent],
      providers: [provideZonelessChangeDetection()],
    });
    const fixture = createComponentFixture(TooltipHostComponent);
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector("button") as HTMLButtonElement;
    expect(button.getAttribute("title")).toBeNull();

    button.dispatchEvent(new Event("mouseenter"));
    vi.advanceTimersByTime(299);
    expect(tooltipElement()).toBeNull();

    vi.advanceTimersByTime(1);
    fixture.detectChanges();

    expect(tooltipElement()?.textContent).toBe("Helpful text");
    expect(tooltipElement()?.closest(".k-tooltip-panel")?.classList.contains("k-tooltip-panel-top")).toBe(true);
  });

  it("hides on mouse leave", () => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      imports: [TooltipHostComponent],
      providers: [provideZonelessChangeDetection()],
    });
    const fixture = createComponentFixture(TooltipHostComponent);
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector("button") as HTMLButtonElement;
    button.dispatchEvent(new Event("mouseenter"));
    vi.advanceTimersByTime(300);
    expect(tooltipElement()).not.toBeNull();

    button.dispatchEvent(new Event("mouseleave"));
    fixture.detectChanges();

    expect(tooltipElement()).toBeNull();
    expect(button.hasAttribute("aria-describedby")).toBe(false);
  });

  it("hides when a nested container scrolls", () => {
    TestBed.configureTestingModule({
      imports: [TooltipHostComponent],
      providers: [provideZonelessChangeDetection()],
    });
    const fixture = createComponentFixture(TooltipHostComponent);
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector("button") as HTMLButtonElement;
    button.dispatchEvent(new FocusEvent("focusin"));
    fixture.detectChanges();
    expect(tooltipElement()).not.toBeNull();

    fixture.nativeElement.dispatchEvent(new Event("scroll"));
    fixture.detectChanges();

    expect(tooltipElement()).toBeNull();
    expect(button.hasAttribute("aria-describedby")).toBe(false);
  });

  it("auto-hides after 10 seconds while still hovered", () => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      imports: [TooltipHostComponent],
      providers: [provideZonelessChangeDetection()],
    });
    const fixture = createComponentFixture(TooltipHostComponent);
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector("button") as HTMLButtonElement;
    button.dispatchEvent(new Event("mouseenter"));
    vi.advanceTimersByTime(300);
    fixture.detectChanges();
    expect(tooltipElement()).not.toBeNull();

    vi.advanceTimersByTime(9_999);
    fixture.detectChanges();
    expect(tooltipElement()).not.toBeNull();

    vi.advanceTimersByTime(1);
    fixture.detectChanges();

    expect(tooltipElement()).toBeNull();
    expect(button.hasAttribute("aria-describedby")).toBe(false);
  });

  it("shows on focus and wires aria-describedby while visible", () => {
    TestBed.configureTestingModule({
      imports: [TooltipHostComponent],
      providers: [provideZonelessChangeDetection()],
    });
    const fixture = createComponentFixture(TooltipHostComponent);
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector("button") as HTMLButtonElement;
    button.dispatchEvent(new FocusEvent("focusin"));
    fixture.detectChanges();

    const tooltip = tooltipElement();
    expect(tooltip?.id).toBeTruthy();
    expect(button.getAttribute("aria-describedby")).toBe(tooltip?.id);

    button.dispatchEvent(new FocusEvent("focusout"));
    fixture.detectChanges();

    expect(tooltipElement()).toBeNull();
    expect(button.hasAttribute("aria-describedby")).toBe(false);
  });

  // The touch window only covers events right after a tap; a focus a phone restores later (a panel
  // closing onto its trigger) would otherwise raise a tooltip nothing can hover away.
  it("never shows on a touch-only device, for hover or focus", () => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("any-hover: none"), media: query }));
    try {
      TestBed.configureTestingModule({
        imports: [TooltipHostComponent],
        providers: [provideZonelessChangeDetection()],
      });
      const fixture = createComponentFixture(TooltipHostComponent);
      fixture.detectChanges();

      const button = fixture.nativeElement.querySelector("button") as HTMLButtonElement;
      button.dispatchEvent(new Event("mouseenter"));
      vi.advanceTimersByTime(300);
      button.dispatchEvent(new FocusEvent("focusin"));
      fixture.detectChanges();

      expect(tooltipElement()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("suppresses empty and disabled tooltips", () => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      imports: [TooltipHostComponent],
      providers: [provideZonelessChangeDetection()],
    });
    const fixture = createComponentFixture(TooltipHostComponent);
    fixture.componentInstance.text.set("");
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector("button") as HTMLButtonElement;
    button.dispatchEvent(new Event("mouseenter"));
    vi.advanceTimersByTime(300);
    expect(tooltipElement()).toBeNull();

    fixture.componentInstance.text.set("Helpful text");
    fixture.componentInstance.disabled.set(true);
    fixture.detectChanges();
    button.dispatchEvent(new Event("mouseenter"));
    vi.advanceTimersByTime(300);
    expect(tooltipElement()).toBeNull();
  });

  it("hides on Escape even when another document handler consumes the bubbling event", () => {
    TestBed.configureTestingModule({
      imports: [TooltipHostComponent],
      providers: [provideZonelessChangeDetection()],
    });
    const fixture = createComponentFixture(TooltipHostComponent);
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
    TestBed.configureTestingModule({
      imports: [TooltipHostComponent],
      providers: [provideZonelessChangeDetection()],
    });
    const fixture = createComponentFixture(TooltipHostComponent);
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector("button") as HTMLButtonElement;
    button.dispatchEvent(new Event("mouseenter"));
    vi.advanceTimersByTime(300);
    expect(tooltipElement()).not.toBeNull();

    document.body.classList.add("is-checklist-dragging");
    document.dispatchEvent(new CustomEvent("kanera:drag-start"));
    fixture.detectChanges();
    expect(tooltipElement()).toBeNull();

    button.dispatchEvent(new Event("mouseenter"));
    vi.advanceTimersByTime(300);
    expect(tooltipElement()).toBeNull();
  });
  it("with a truncation target, shows only while that element overflows", () => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      imports: [TruncationHostComponent],
      providers: [provideZonelessChangeDetection()],
    });
    const fixture = createComponentFixture(TruncationHostComponent);
    fixture.detectChanges();

    const link = fixture.nativeElement.querySelector("a") as HTMLAnchorElement;
    const label = link.querySelector(".label") as HTMLSpanElement;
    // jsdom lays nothing out, so both extents read 0: the label fits and the tooltip must stay away.
    link.dispatchEvent(new Event("mouseenter"));
    vi.advanceTimersByTime(400);
    fixture.detectChanges();
    expect(tooltipElement()).toBeNull();

    link.dispatchEvent(new Event("mouseleave"));
    vi.advanceTimersByTime(400);
    Object.defineProperty(label, "scrollWidth", { value: 240, configurable: true });
    Object.defineProperty(label, "clientWidth", { value: 120, configurable: true });
    link.dispatchEvent(new Event("mouseenter"));
    vi.advanceTimersByTime(400);
    fixture.detectChanges();
    expect(tooltipElement()?.textContent).toBe("Quarterly Roadmap Planning");
  });
});
