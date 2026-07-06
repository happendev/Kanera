import type { OnDestroy, OnInit} from "@angular/core";
import { Directive, ElementRef, inject } from "@angular/core";
import { APP_DOM_EVENTS } from "../../core/browser/browser-contracts";

type RectReader = HTMLElement["getBoundingClientRect"];
interface CachedDropTargetGeometry {
  left: number;
  right: number;
  bottom: number;
}

export function extendRectToViewportBottom(rect: DOMRect, viewportBottom: number): DOMRect {
  const bottom = Math.max(rect.bottom, viewportBottom);
  return new DOMRect(rect.left, rect.top, rect.width, bottom - rect.top);
}

export function extendDropTargetRect(
  element: HTMLElement,
  rect: DOMRect,
  viewportBottom: () => number,
  cachedGeometry: CachedDropTargetGeometry | null = null,
): DOMRect {
  const host = element.closest<HTMLElement>("k-list");
  const hostRect = cachedGeometry ? null : host?.getBoundingClientRect();
  // CDK caches drop-list geometry at drag start. Short lists need the logical target to use
  // the full list column width and the remaining kanban lane height, while the visible card
  // list keeps its natural height.
  const left = cachedGeometry?.left ?? hostRect?.left ?? rect.left;
  const right = cachedGeometry?.right ?? hostRect?.right ?? rect.right;
  const bottom = Math.max(rect.bottom, cachedGeometry?.bottom ?? dropTargetBoundaryBottom(element, viewportBottom));
  return new DOMRect(left, rect.top, right - left, bottom - rect.top);
}

export function dropTargetBoundaryBottom(element: HTMLElement, viewportBottom: () => number): number {
  const lane = element.closest<HTMLElement>(".lists");
  // Prefer the kanban scroller bottom over the browser viewport so a short column's drop area
  // matches the board lane, not unrelated page chrome below it.
  return lane?.getBoundingClientRect().bottom ?? viewportBottom();
}

export function patchViewportDropTargetRect(
  element: HTMLElement,
  viewportBottom: () => number,
  extendRect: (element: HTMLElement, rect: DOMRect, viewportBottom: () => number) => DOMRect = extendDropTargetRect,
): () => void {
  const original = element.getBoundingClientRect.bind(element) as RectReader;

  element.getBoundingClientRect = function patchedGetBoundingClientRect(): DOMRect {
    const rect = original.call(element);
    return extendRect(element, rect, viewportBottom);
  } as RectReader;

  return () => {
    element.getBoundingClientRect = original;
  };
}

@Directive({ selector: "[kViewportDropTarget]", standalone: true })
export class ViewportDropTargetDirective implements OnInit, OnDestroy {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);
  private cleanup?: () => void;
  private cleanupExtensionTracking?: () => void;
  private extensionFrame: number | null = null;
  private cachedGeometry: CachedDropTargetGeometry | null = null;

  ngOnInit() {
    this.cleanup = patchViewportDropTargetRect(
      this.el.nativeElement,
      () => window.innerHeight,
      (element, rect, viewportBottom) => extendDropTargetRect(element, rect, viewportBottom, this.cachedGeometry),
    );
    this.cleanupExtensionTracking = this.trackDropExtensionGeometry();
  }

  ngOnDestroy() {
    this.cleanup?.();
    this.cleanupExtensionTracking?.();
  }

  private trackDropExtensionGeometry(): () => void {
    let dragging = false;
    let lane: HTMLElement | null = null;
    const update = () => this.scheduleDropExtensionGeometryUpdate();
    const onDragState = (event: Event) => {
      dragging = event instanceof CustomEvent ? !!event.detail : false;
      if (dragging) this.updateDropExtensionGeometry();
      else this.cachedGeometry = null;
    };
    const onLaneScroll = () => {
      if (dragging) update();
    };

    document.addEventListener(APP_DOM_EVENTS.CARD_DRAG_STATE, onDragState);
    lane = this.el.nativeElement.closest<HTMLElement>(".lists");
    lane?.addEventListener("scroll", onLaneScroll, { passive: true });

    return () => {
      if (this.extensionFrame !== null) {
        window.cancelAnimationFrame(this.extensionFrame);
        this.extensionFrame = null;
      }
      document.removeEventListener(APP_DOM_EVENTS.CARD_DRAG_STATE, onDragState);
      lane?.removeEventListener("scroll", onLaneScroll);
    };
  }

  private scheduleDropExtensionGeometryUpdate() {
    if (this.extensionFrame !== null) return;
    this.extensionFrame = window.requestAnimationFrame(() => {
      this.extensionFrame = null;
      this.updateDropExtensionGeometry();
    });
  }

  private updateDropExtensionGeometry() {
    const element = this.el.nativeElement;
    const rect = element.getBoundingClientRect();
    const hostRect = element.closest<HTMLElement>("k-list")?.getBoundingClientRect();
    const left = hostRect?.left ?? rect.left;
    const right = hostRect?.right ?? rect.right;
    // CDK also requires elementFromPoint() to hit the drop list or one of its children before
    // accepting a sibling list. This transparent fixed child makes the empty lane below a short
    // list a real hit surface without stretching the visible k-list card.
    const top = Math.min(rect.bottom, rect.top + element.offsetHeight);
    const bottom = dropTargetBoundaryBottom(element, () => window.innerHeight);
    this.cachedGeometry = { left, right, bottom };

    element.style.setProperty("--k-drop-extension-left", `${left}px`);
    element.style.setProperty("--k-drop-extension-top", `${top}px`);
    element.style.setProperty("--k-drop-extension-width", `${Math.max(0, right - left)}px`);
    element.style.setProperty("--k-drop-extension-height", `${Math.max(0, bottom - top)}px`);
  }
}
