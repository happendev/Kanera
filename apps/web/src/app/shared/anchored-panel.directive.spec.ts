import { ChangeDetectionStrategy, Component, provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AnchoredPanelDirective } from "./anchored-panel.directive";
import { PanelStackService } from "./panel-stack.service";

@Component({
  standalone: true,
  imports: [AnchoredPanelDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap">
      <button #trigger class="trigger" type="button" (click)="open.update((value) => !value)">Open</button>
      @if (open()) {
        <div
          class="panel"
          kAnchoredPanel
          [apAnchor]="trigger"
          [apPlacement]="{ width: 200 }"
          [apInline]="inline()"
          (apDismissed)="open.set(false)"
        ></div>
      }
    </div>
  `,
})
class PanelHostComponent {
  readonly open = signal(false);
  readonly inline = signal(false);
}

describe("AnchoredPanelDirective", () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
  });

  async function render(inline = false) {
    const fixture = TestBed.createComponent(PanelHostComponent);
    fixture.componentInstance.inline.set(inline);
    await fixture.whenStable();

    const root = fixture.nativeElement as HTMLElement;
    const openPanel = async () => {
      root.querySelector("button")!.click();
      await fixture.whenStable();
    };
    return { fixture, root, openPanel, panel: () => root.querySelector<HTMLElement>(".panel") };
  }

  it("survives the click that opened it, then dismisses on the next outside click", async () => {
    const { fixture, openPanel, panel } = await render();

    // The opening click reaches `document` before the panel mounts, so the panel is not yet a stack
    // layer and cannot close itself. Registration in `ngAfterViewInit` is what guarantees that.
    await openPanel();
    expect(fixture.componentInstance.open()).toBe(true);
    expect(panel()).not.toBeNull();

    // Proves the first assertion is not vacuous: the dismissal path is live by now.
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await fixture.whenStable();

    expect(fixture.componentInstance.open()).toBe(false);
  });

  it("treats its trigger as inside so a second trigger click toggles it closed", async () => {
    const { fixture, root, openPanel } = await render();
    await openPanel();

    root.querySelector<HTMLButtonElement>(".trigger")!.click();
    await fixture.whenStable();

    expect(fixture.componentInstance.open()).toBe(false);
    expect(TestBed.inject(PanelStackService).depth).toBe(0);
  });

  it("reveals the panel by publishing placement and the is-positioned class", async () => {
    const { openPanel, panel } = await render();
    await openPanel();

    expect(panel()!.classList.contains("is-positioned")).toBe(true);
    expect(panel()!.style.getPropertyValue("--ap-left")).not.toBe("");
  });

  it("repositions when ResizeObserver reports anchor or panel content growth", async () => {
    let resizeCallback: ResizeObserverCallback | null = null;
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    try {
      const { root, openPanel, panel } = await render();
      const trigger = root.querySelector<HTMLButtonElement>(".trigger")!;
      trigger.getBoundingClientRect = () => new DOMRect(80, 20, 30, 20);
      await openPanel();
      expect(panel()!.style.getPropertyValue("--ap-left")).toBe("80px");

      trigger.getBoundingClientRect = () => new DOMRect(180, 20, 30, 20);
      const callback = resizeCallback as ResizeObserverCallback | null;
      if (!callback) throw new Error("ResizeObserver was not created");
      callback([], {} as ResizeObserver);

      expect(panel()!.style.getPropertyValue("--ap-left")).toBe("180px");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("skips placement for an inline panel but still marks it positioned", async () => {
    // The filter bar embeds the date-range picker in flow; it keeps the class contract but must not
    // be positioned, listened to, or registered as a stack layer.
    const { openPanel, panel } = await render(true);
    await openPanel();

    expect(panel()!.classList.contains("is-positioned")).toBe(true);
    expect(panel()!.style.getPropertyValue("--ap-left")).toBe("");
    expect(TestBed.inject(PanelStackService).depth).toBe(0);
  });

  it("unregisters and drops its viewport listeners on teardown", async () => {
    const { fixture, openPanel } = await render();
    await openPanel();

    const stack = TestBed.inject(PanelStackService);
    expect(stack.depth).toBe(1);

    const removeSpy = vi.spyOn(window, "removeEventListener");
    fixture.componentInstance.open.set(false);
    await fixture.whenStable();

    expect(stack.depth).toBe(0);
    expect(removeSpy).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith("scroll", expect.any(Function), true);
    removeSpy.mockRestore();
  });
});
