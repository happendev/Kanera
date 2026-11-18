import { CdkDrag } from "@angular/cdk/drag-drop";
import { ChangeDetectorRef, DestroyRef, Directive, ElementRef, inject } from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { BoardState } from "./board-state";
import { CARD_DRAG_START_DELAY } from "./card-drag-scroll";

/**
 * Collapses expanded card checklists before a card drag, so the drag preview and placeholder are
 * measured from the compact tile. Lives in its own file because Angular's dev-server hot reload
 * must import every symbol in a component's `imports` by name.
 */
@Directive({
  selector: "[kCloseCardChecklistsBeforeDrag]",
  standalone: true,
})
export class CloseCardChecklistsBeforeDragDirective {
  private readonly drag = inject(CdkDrag);
  private readonly state = inject(BoardState);
  private readonly changeDetectorRef = inject(ChangeDetectorRef);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private press: { x: number; y: number; at: number; touch: boolean; onChecklist: boolean } | null = null;
  private stopWatchingPress: (() => void) | null = null;

  constructor() {
    // `beforeStarted` fires on every press, not only on drags, and carries no event, so record the
    // press first (a capture listener on the host runs before CDK's own).
    const recordPress = (event: MouseEvent | TouchEvent) => {
      const point = "touches" in event ? event.touches[0] : event;
      if (!point) return;
      this.press = {
        x: point.clientX,
        y: point.clientY,
        at: Date.now(),
        touch: "touches" in event,
        onChecklist: event.target instanceof Element && !!event.target.closest(".card-checklist-toggle, .card-checklists"),
      };
    };
    this.host.addEventListener("mousedown", recordPress, { capture: true, passive: true });
    this.host.addEventListener("touchstart", recordPress, { capture: true, passive: true });

    this.drag._dragRef.beforeStarted.pipe(takeUntilDestroyed()).subscribe(() => {
      if (this.press?.onChecklist) {
        // Collapsing on press would remove the checklist under the pointer: the toggle's click
        // would reopen it and an item's click would be lost. Collapse only once this press turns
        // into a drag instead.
        this.watchPressForDrag();
        return;
      }
      // CDK captures the source rectangle immediately after `beforeStarted`. Render the collapsed
      // card first so its preview and placeholder are measured from the compact tile geometry.
      this.collapseChecklists();
    });
    inject(DestroyRef).onDestroy(() => this.stopWatchingPress?.());
  }

  private collapseChecklists() {
    this.state.closeCardChecklists();
    this.changeDetectorRef.detectChanges();
  }

  private watchPressForDrag() {
    this.stopWatchingPress?.();
    const doc = this.host.ownerDocument;
    // Registered during `beforeStarted`, so this capture listener runs before the one CDK binds
    // right after it, and the collapse lands before CDK crosses its threshold and builds the preview.
    const onMove = (event: MouseEvent | TouchEvent) => {
      const press = this.press;
      const point = "touches" in event ? event.touches[0] : event;
      if (!press || !point || this.drag.disabled) return;
      const ref = this.drag._dragRef as unknown as {
        _config: { dragStartThreshold: number };
        _initialDomRect?: DOMRect;
        _pickupPositionInElement: { x: number; y: number };
      };
      const distance = Math.abs(point.clientX - press.x) + Math.abs(point.clientY - press.y);
      const delay = press.touch ? CARD_DRAG_START_DELAY.touch : CARD_DRAG_START_DELAY.mouse;
      if (distance < ref._config.dragStartThreshold) return;
      stop();
      // CDK cancels a press that moves before the start delay; that is not a drag.
      if (Date.now() < press.at + delay) return;

      this.collapseChecklists();
      // CDK measured the expanded card on press. Re-measure the compact tile and keep the grab
      // point inside it, so the preview is tile-sized and stays under the pointer.
      const rect = this.host.getBoundingClientRect();
      ref._initialDomRect = rect;
      ref._pickupPositionInElement = {
        x: Math.min(Math.max(press.x - rect.left, 0), rect.width),
        y: Math.min(Math.max(press.y - rect.top, 0), Math.max(rect.height - 12, 0)),
      };
    };
    const stop = () => {
      doc.removeEventListener("mousemove", onMove, true);
      doc.removeEventListener("touchmove", onMove, true);
      doc.removeEventListener("mouseup", stop, true);
      doc.removeEventListener("touchend", stop, true);
      doc.removeEventListener("touchcancel", stop, true);
      this.stopWatchingPress = null;
    };
    doc.addEventListener("mousemove", onMove, { capture: true, passive: true });
    doc.addEventListener("touchmove", onMove, { capture: true, passive: true });
    doc.addEventListener("mouseup", stop, true);
    doc.addEventListener("touchend", stop, true);
    doc.addEventListener("touchcancel", stop, true);
    this.stopWatchingPress = stop;
  }
}
