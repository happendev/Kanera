import type { OnDestroy, OnInit} from "@angular/core";
import { Directive, ElementRef, inject } from "@angular/core";
import { APP_DOM_EVENTS } from "../../core/browser/browser-contracts";

type RectReader = HTMLElement["getBoundingClientRect"];

export function extendRectToViewportBottom(rect: DOMRect, viewportBottom: number): DOMRect {
  const bottom = Math.max(rect.bottom, viewportBottom);
  return new DOMRect(rect.left, rect.top, rect.width, bottom - rect.top);
}

export function extendDropTargetRect(element: HTMLElement, rect: DOMRect, viewportBottom: () => number): DOMRect {
  const host = element.closest<HTMLElement>("k-list");
  const hostRect = host?.getBoundingClientRect();
  // CDK caches drop-list geometry at drag start. Short lists need the logical target to use
  // the full list column width and the remaining kanban lane height, while the visible card
  // list keeps its natural height.
  const left = hostRect?.left ?? rect.left;
  const right = hostRect?.right ?? rect.right;
  const bottom = Math.max(rect.bottom, dropTargetBoundaryBottom(element, viewportBottom));
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

  ngOnInit() {
    this.cleanup = patchViewportDropTargetRect(
      this.el.nativeElement,
      () => window.innerHeight,
    );
    this.cleanupExtensionTracking = this.trackDropExtensionGeometry();
  }

  ngOnDestroy() {
    this.cleanup?.();
    this.cleanupExtensionTracking?.();
  }

  private trackDropExtensionGeometry(): () => void {
    const update = () => this.updateDropExtensionGeometry();
    const onDragState = (event: Event) => {
      const active = event instanceof CustomEvent ? !!event.detail : false;
      if (active) update();
    };

    document.addEventListener(APP_DOM_EVENTS.CARD_DRAG_STATE, onDragState);
    document.addEventListener(APP_DOM_EVENTS.CARD_DRAG_MOVE, update);

    return () => {
      document.removeEventListener(APP_DOM_EVENTS.CARD_DRAG_STATE, onDragState);
      document.removeEventListener(APP_DOM_EVENTS.CARD_DRAG_MOVE, update);
    };
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

    element.style.setProperty("--k-drop-extension-left", `${left}px`);
    element.style.setProperty("--k-drop-extension-top", `${top}px`);
    element.style.setProperty("--k-drop-extension-width", `${Math.max(0, right - left)}px`);
    element.style.setProperty("--k-drop-extension-height", `${Math.max(0, bottom - top)}px`);
  }
}
