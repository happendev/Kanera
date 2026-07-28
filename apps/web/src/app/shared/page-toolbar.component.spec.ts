import { ChangeDetectionStrategy, Component, provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it, vi } from "vitest";
import { PageToolbarComponent } from "./page-toolbar.component";
import { PanelStackService } from "./panel-stack.service";

@Component({
  standalone: true,
  imports: [PageToolbarComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <k-page-toolbar [compactActive]="compactActive()">
      <span ptSearch class="slot-search">search</span>
      <div ptControls class="slot-controls">controls</div>
      <span ptTail class="slot-tail">tail</span>
    </k-page-toolbar>
  `,
})
class HostComponent {
  readonly compactActive = signal(false);
}

async function mount() {
  await TestBed.configureTestingModule({
    imports: [HostComponent],
    providers: [provideZonelessChangeDetection()],
  }).compileComponents();

  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return {
    fixture,
    host: fixture.nativeElement as HTMLElement,
    stack: TestBed.inject(PanelStackService),
    trigger: () => (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(".pt-compact"),
    body: () => (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(".pt-controls"),
  };
}

describe("PageToolbarComponent", () => {
  it("keeps search outside the collapsing body so it stays visible when collapsed", async () => {
    const { host } = await mount();

    expect(host.querySelector(".pt-search .slot-search")).toBeTruthy();
    expect(host.querySelector(".pt-controls .slot-search")).toBeNull();
    expect(host.querySelector(".pt-controls .slot-controls")).toBeTruthy();
    expect(host.querySelector(".pt-tail .slot-tail")).toBeTruthy();
  });

  // Wrapping belongs to .pt-main, not the bar. With the bar wrapping, the tail was the item pushed
  // onto a line of its own and then right-aligned by an auto margin — a whole empty row for one
  // control at any width where the query controls did not quite fit.
  it("wraps search and controls inside .pt-main, with the tail outside it", async () => {
    const { host } = await mount();

    expect(host.querySelector(".pt-main .pt-search")).toBeTruthy();
    expect(host.querySelector(".pt-main .pt-controls")).toBeTruthy();
    expect(host.querySelector(".pt-main .pt-tail")).toBeNull();
    expect(host.querySelector(".pt-bar > .pt-tail")).toBeTruthy();
  });

  it("starts collapsed and opens the controls body on the trigger", async () => {
    const { fixture, trigger, body } = await mount();

    expect(body()?.classList.contains("is-open")).toBe(false);
    expect(trigger()?.getAttribute("aria-expanded")).toBe("false");

    trigger()?.click();
    fixture.detectChanges();

    expect(body()?.classList.contains("is-open")).toBe(true);
    expect(trigger()?.getAttribute("aria-expanded")).toBe("true");
  });

  it("registers the open body with the panel stack and unregisters when it closes", async () => {
    const { fixture, trigger, stack } = await mount();
    expect(stack.depth).toBe(0);

    trigger()?.click();
    fixture.detectChanges();
    expect(stack.depth).toBe(1);

    trigger()?.click();
    fixture.detectChanges();
    expect(stack.depth).toBe(0);
  });

  it("dismisses on an outside pointer but not on a click inside its own trigger", async () => {
    const { fixture, trigger, body } = await mount();
    trigger()?.click();
    fixture.detectChanges();
    expect(body()?.classList.contains("is-open")).toBe(true);

    // The stack sees the trigger's own click in the capture phase; keepOpenWithin is what stops that
    // dismissing the panel the click is about to toggle.
    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    fixture.detectChanges();

    expect(body()?.classList.contains("is-open")).toBe(false);
  });

  it("keeps the body open behind a picker opened from inside it, and closes the picker first", async () => {
    const { fixture, trigger, body, stack } = await mount();
    trigger()?.click();
    fixture.detectChanges();

    // Exactly what AnchoredPanelDirective does for a picker rendered inside the body: DOM
    // containment makes it a child layer rather than an unrelated one that would supersede the body.
    const picker = body()?.querySelector<HTMLElement>(".slot-controls");
    if (!picker) throw new Error("Expected a projected control to stand in for a picker.");
    const pickerDismissed = vi.fn();
    const unregisterPicker = stack.register({ hostEl: picker, dismiss: pickerDismissed });
    expect(stack.depth).toBe(2);

    // Clicking inside the picker protects its whole opener chain, so the body survives.
    const inside = new MouseEvent("click", { bubbles: true });
    Object.defineProperty(inside, "target", { value: picker });
    stack.handlePointer(inside);
    fixture.detectChanges();
    expect(pickerDismissed).not.toHaveBeenCalled();
    expect(body()?.classList.contains("is-open")).toBe(true);

    // Escape unwinds innermost-first: the picker, then the body.
    stack.handleEscape(new KeyboardEvent("keydown", { key: "Escape" }));
    fixture.detectChanges();
    expect(pickerDismissed).toHaveBeenCalledOnce();
    expect(body()?.classList.contains("is-open")).toBe(true);

    stack.handleEscape(new KeyboardEvent("keydown", { key: "Escape" }));
    fixture.detectChanges();
    expect(body()?.classList.contains("is-open")).toBe(false);

    unregisterPicker();
  });

  it("closes on Escape", async () => {
    const { fixture, trigger, body } = await mount();
    trigger()?.click();
    fixture.detectChanges();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    fixture.detectChanges();

    expect(body()?.classList.contains("is-open")).toBe(false);
  });

  it("takes no z-index of its own on the open panel — the stack owns paint order", async () => {
    const { fixture, trigger, body } = await mount();
    trigger()?.click();
    fixture.detectChanges();

    // PanelStackService writes the inline order; the component must not compete with a literal.
    expect(body()?.style.zIndex).toBe("calc(var(--z-panel, 300) + 0)");
  });

  it("accents the trigger when a control is away from its default", async () => {
    const { fixture, trigger } = await mount();
    expect(trigger()?.classList.contains("is-set")).toBe(false);

    fixture.componentInstance.compactActive.set(true);
    fixture.detectChanges();

    expect(trigger()?.classList.contains("is-set")).toBe(true);
  });
});
