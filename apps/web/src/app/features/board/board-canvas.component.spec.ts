import { CdkDropList, CdkDropListGroup } from "@angular/cdk/drag-drop";
import { CUSTOM_ELEMENTS_SCHEMA, ChangeDetectionStrategy, Component, provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { By } from "@angular/platform-browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_DOM_EVENTS } from "../../core/browser/browser-contracts";
import { BoardCanvasComponent } from "./board-canvas.component";
import { CardDragCoordinator } from "./card-drag-coordinator.service";

@Component({
  standalone: true,
  imports: [BoardCanvasComponent, CdkDropList],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <k-board>
      <div cdkDropList id="list-one"></div>
      <div cdkDropList id="list-two"></div>
    </k-board>
  `,
})
class BoardCanvasTestHostComponent {
  readonly rendered = true;
}

/** Two canvases, as a consolidated page mounts them — one per workspace section. */
@Component({
  standalone: true,
  imports: [BoardCanvasComponent],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <k-board class="canvas-a"><k-list data-list-id="list-a"></k-list></k-board>
    <k-board class="canvas-b"><k-list data-list-id="list-b"></k-list></k-board>
  `,
})
class TwoCanvasHostComponent {
  readonly rendered = true;
}

describe("BoardCanvasComponent", () => {
  it("places projected lists in one shared drag group", () => {
    TestBed.configureTestingModule({
      imports: [BoardCanvasTestHostComponent],
      providers: [provideZonelessChangeDetection()],
    });
    const fixture = TestBed.createComponent(BoardCanvasTestHostComponent);
    fixture.detectChanges();

    const group = fixture.debugElement.query(By.directive(CdkDropListGroup)).injector.get(CdkDropListGroup);
    const dropLists = fixture.debugElement.queryAll(By.directive(CdkDropList)).map((node) => node.injector.get(CdkDropList));

    expect(dropLists).toHaveLength(2);
    expect([...group._items]).toEqual(dropLists);
  });

  it("scrolls horizontally when its background is dragged", () => {
    TestBed.configureTestingModule({
      imports: [BoardCanvasTestHostComponent],
      providers: [provideZonelessChangeDetection()],
    });
    const fixture = TestBed.createComponent(BoardCanvasTestHostComponent);
    fixture.detectChanges();
    const board = fixture.debugElement.query(By.directive(BoardCanvasComponent)).nativeElement as HTMLElement;
    board.scrollLeft = 120;

    board.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 200 }));
    window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 150 }));

    expect(board.scrollLeft).toBe(170);
    expect(board.classList.contains("is-dragging")).toBe(true);

    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    expect(board.classList.contains("is-dragging")).toBe(false);
  });

  describe("card drag", () => {
    // The canvas hit-tests lists with CSS.escape and gates mobile centring on matchMedia; this test
    // environment supplies neither.
    const originalCss = globalThis.CSS;
    const originalMatchMedia = window.matchMedia;

    beforeEach(() => {
      Object.defineProperty(globalThis, "CSS", {
        configurable: true,
        value: { ...originalCss, escape: (value: string) => value },
      });
      Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: true }) });
    });

    afterEach(() => {
      Object.defineProperty(globalThis, "CSS", { configurable: true, value: originalCss });
      Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
      vi.restoreAllMocks();
    });

    function mountTwoCanvases() {
      TestBed.configureTestingModule({
        imports: [TwoCanvasHostComponent],
        providers: [provideZonelessChangeDetection()],
      });
      const fixture = TestBed.createComponent(TwoCanvasHostComponent);
      fixture.detectChanges();
      const [a, b] = fixture.debugElement
        .queryAll(By.directive(BoardCanvasComponent))
        .map((node) => node.nativeElement as HTMLElement);
      return { fixture, a, b, coordinator: TestBed.inject(CardDragCoordinator) };
    }

    it("only the canvas holding the dragged card reacts", () => {
      // The guard that stops N mounted canvases each running an edge-scroll loop: every extra loop
      // would add another window.scrollBy() per frame and scroll unrelated lanes sideways.
      vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 42);
      vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
      const { fixture, a, b, coordinator } = mountTwoCanvases();

      try {
        coordinator.start("list-a");
        fixture.detectChanges();
        expect(document.body.classList.contains("is-card-dragging")).toBe(true);
        expect(a.classList.contains("is-card-dragging")).toBe(true);
        expect(b.classList.contains("is-card-dragging")).toBe(false);

        coordinator.end();
        fixture.detectChanges();
        expect(document.body.classList.contains("is-card-dragging")).toBe(false);
        expect(a.classList.contains("is-card-dragging")).toBe(false);
        expect(b.classList.contains("is-card-dragging")).toBe(false);

        coordinator.start("list-b");
        fixture.detectChanges();
        expect(a.classList.contains("is-card-dragging")).toBe(false);
        expect(b.classList.contains("is-card-dragging")).toBe(true);
      } finally {
        coordinator.end();
        fixture.destroy();
      }
    });

    it("settles each drag on its own drop target, and ignores another canvas's", async () => {
      vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 42);
      vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
      const { fixture, a, b, coordinator } = mountTwoCanvases();
      const scrollA = vi.fn();
      const scrollB = vi.fn();
      a.querySelector("k-list")!.scrollIntoView = scrollA;
      b.querySelector("k-list")!.scrollIntoView = scrollB;

      try {
        coordinator.start("list-a");
        fixture.detectChanges();
        document.dispatchEvent(new CustomEvent(APP_DOM_EVENTS.CARD_DROP_TARGET, { detail: "list-a" }));
        coordinator.end();
        fixture.detectChanges();
        await Promise.resolve();

        expect(scrollA).toHaveBeenCalledOnce();
        expect(scrollA).toHaveBeenCalledWith({ behavior: "smooth", block: "nearest", inline: "center" });
        // Canvas B never held the drag, so its own list must not be re-centred by it.
        expect(scrollB).not.toHaveBeenCalled();

        // A drop announced after the drag has already ended still settles: CDK's touch path can emit
        // dragEnded before dropListDropped.
        coordinator.start("list-a");
        fixture.detectChanges();
        coordinator.end();
        fixture.detectChanges();
        document.dispatchEvent(new CustomEvent(APP_DOM_EVENTS.CARD_DROP_TARGET, { detail: "list-a" }));
        await Promise.resolve();
        expect(scrollA).toHaveBeenCalledTimes(2);
      } finally {
        coordinator.end();
        fixture.destroy();
      }
    });
  });
});
