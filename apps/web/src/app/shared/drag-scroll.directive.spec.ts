import { ChangeDetectionStrategy, Component, provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it, vi } from "vitest";
import { DragScrollDirective, ScrollSyncGroup } from "./drag-scroll.directive";

@Component({
  standalone: true,
  imports: [DragScrollDirective],
  providers: [ScrollSyncGroup],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pane one" kDragScroll><button type="button" class="tile" (click)="tileClicked()"></button></div>
    <div class="pane two" kDragScroll></div>
  `,
})
class DragScrollHostComponent {
  readonly tileClicked = vi.fn();
}

describe("DragScrollDirective", () => {
  async function create() {
    TestBed.configureTestingModule({
      imports: [DragScrollHostComponent],
      providers: [provideZonelessChangeDetection()],
    });
    const fixture = TestBed.createComponent(DragScrollHostComponent);
    fixture.detectChanges();
    await fixture.whenStable();

    const host = fixture.nativeElement as HTMLElement;
    const panes = [...host.querySelectorAll<HTMLElement>(".pane")];
    // jsdom has no layout, so the scrollability the directive gates on has to be declared.
    for (const pane of panes) {
      Object.defineProperty(pane, "scrollWidth", { value: 1400, configurable: true });
      Object.defineProperty(pane, "clientWidth", { value: 400, configurable: true });
    }
    return { fixture, one: panes[0]!, two: panes[1]! };
  }

  it("scrolls horizontally with the pointer and swallows the click the drag ends on", async () => {
    const { fixture, one } = await create();
    const tile = one.querySelector<HTMLElement>(".tile")!;
    one.scrollLeft = 100;

    one.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 300 }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 240 }));

    expect(one.scrollLeft).toBe(160);
    expect(one.classList.contains("is-drag-scrolling")).toBe(true);

    window.dispatchEvent(new MouseEvent("mouseup"));
    expect(one.classList.contains("is-drag-scrolling")).toBe(false);

    // The browser synthesises a click over whatever the drag finished on; it must not open the card.
    tile.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(fixture.componentInstance.tileClicked).not.toHaveBeenCalled();

    // Only that one click is eaten, so the next real press still works.
    tile.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(fixture.componentInstance.tileClicked).toHaveBeenCalledTimes(1);
  });

  it("lets a press that never travels through as a click", async () => {
    const { fixture, one } = await create();
    const tile = one.querySelector<HTMLElement>(".tile")!;

    tile.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 300 }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 298 }));
    window.dispatchEvent(new MouseEvent("mouseup"));
    tile.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(one.classList.contains("is-drag-scrolling")).toBe(false);
    expect(fixture.componentInstance.tileClicked).toHaveBeenCalledTimes(1);
  });

  it("keeps every scroller in the group on the same columns", async () => {
    const { one, two } = await create();

    one.scrollLeft = 240;
    one.dispatchEvent(new Event("scroll"));

    expect(two.scrollLeft).toBe(240);
  });
});
