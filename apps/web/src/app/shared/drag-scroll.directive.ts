import type { OnDestroy } from "@angular/core";
import { Directive, ElementRef, Injectable, Injector, afterNextRender, inject } from "@angular/core";

/** Pointer travel that turns a press into a scroll drag rather than a click on whatever is under it. */
const DRAG_THRESHOLD_PX = 4;

/**
 * One shared horizontal offset for a set of scrollers.
 *
 * The calendar renders a separate horizontal scroller per month panel, and every panel shows the
 * same seven weekday columns. They have to agree on which columns are on screen: scrolling one
 * month across to Thursday while the month below it still shows Monday makes the stack unreadable.
 *
 * Provide this on the component that owns the group; each scroller joins it through `kDragScroll`.
 * Scrollers outside a group still drag, they just do not follow anything.
 */
@Injectable()
export class ScrollSyncGroup {
  private readonly members = new Set<HTMLElement>();
  private offset = 0;

  register(element: HTMLElement): void {
    this.members.add(element);
    // Panels mount and re-mount as data arrives; a late arrival must not open at a different
    // weekday from the ones already on screen.
    if (this.offset) element.scrollLeft = this.offset;
  }

  unregister(element: HTMLElement): void {
    this.members.delete(element);
  }

  /** Whoever moved last defines the group offset. */
  publish(source: HTMLElement): void {
    this.apply(source.scrollLeft, source);
  }

  scrollTo(offset: number): void {
    this.apply(offset, null);
  }

  private apply(offset: number, source: HTMLElement | null): void {
    this.offset = offset;
    for (const member of this.members) {
      // Writing scrollLeft fires that member's own scroll event, which publishes straight back
      // here. Skipping members already in position is what stops the group oscillating.
      if (member !== source && Math.round(member.scrollLeft) !== Math.round(offset)) {
        member.scrollLeft = offset;
      }
    }
  }
}

/**
 * Click-and-drag horizontal scrolling, the same gesture `k-board` gives the kanban lane.
 *
 * Unlike `k-board` — where a drag may only start on the background, because a list is itself
 * draggable — a press anywhere in the scroller starts a drag here, including on a card tile. The
 * gesture only commits past a small threshold, and the click the browser synthesises at the end of
 * a committed drag is swallowed so the drag cannot open the card it finished over.
 */
@Directive({
  selector: "[kDragScroll]",
  standalone: true,
})
export class DragScrollDirective implements OnDestroy {
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly group = inject(ScrollSyncGroup, { optional: true });
  private drag: { startX: number; startScrollLeft: number; moved: boolean } | null = null;
  /** Set when a committed drag ends, so its trailing click does not reach the tile underneath. */
  private suppressClick = false;

  constructor() {
    const el = this.element.nativeElement;
    el.addEventListener("mousedown", this.onMouseDown);
    // Capture, because a card tile would otherwise handle the click before it reached this element.
    el.addEventListener("click", this.onClickCapture, true);
    // Passive and registered by hand rather than through @HostListener: a synced group re-emits
    // scroll on every member, and marking the view dirty on each of those frames is wasted work.
    el.addEventListener("scroll", this.onScroll, { passive: true });
    // Registration has to wait for layout: before the first render the element cannot scroll, so
    // the group's stored offset would be clamped away to zero.
    afterNextRender(() => this.group?.register(el), { injector: this.injector });
  }

  ngOnDestroy(): void {
    const el = this.element.nativeElement;
    this.endDrag();
    this.group?.unregister(el);
    el.removeEventListener("mousedown", this.onMouseDown);
    el.removeEventListener("click", this.onClickCapture, true);
    el.removeEventListener("scroll", this.onScroll);
  }

  private readonly onScroll = () => {
    this.group?.publish(this.element.nativeElement);
  };

  private readonly onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0) return;
    // A drag that ended outside this element never produced a click to swallow. Clearing the flag
    // on the next press is what stops a stale one eating a genuine click later.
    this.suppressClick = false;
    const el = this.element.nativeElement;
    if (el.scrollWidth <= el.clientWidth) return;
    const target = event.target;
    // Controls own their own pointer gestures (caret placement, range dragging, link drag).
    if (target instanceof Element && target.closest("input, textarea, select, a")) return;
    this.drag = { startX: event.clientX, startScrollLeft: el.scrollLeft, moved: false };
    window.addEventListener("mousemove", this.onMouseMove);
    window.addEventListener("mouseup", this.onMouseUp);
  };

  private readonly onMouseMove = (event: MouseEvent) => {
    const drag = this.drag;
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    if (!drag.moved) {
      if (Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
      this.element.nativeElement.classList.add("is-drag-scrolling");
    }
    // Stops the drag becoming a text selection across every card it passes over.
    event.preventDefault();
    this.element.nativeElement.scrollLeft = drag.startScrollLeft - dx;
  };

  private readonly onMouseUp = () => {
    this.suppressClick = this.drag?.moved ?? false;
    this.endDrag();
  };

  private readonly onClickCapture = (event: MouseEvent) => {
    if (!this.suppressClick) return;
    this.suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  };

  private endDrag(): void {
    if (!this.drag) return;
    this.drag = null;
    this.element.nativeElement.classList.remove("is-drag-scrolling");
    window.removeEventListener("mousemove", this.onMouseMove);
    window.removeEventListener("mouseup", this.onMouseUp);
  }
}
