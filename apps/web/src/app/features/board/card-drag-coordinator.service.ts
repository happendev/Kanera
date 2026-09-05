import { Injectable, signal } from "@angular/core";
import { APP_DOM_EVENTS } from "../../core/browser/browser-contracts";

@Injectable({ providedIn: "root" })
export class CardDragCoordinator {
  readonly active = signal(false);
  readonly sourceListId = signal<string | null>(null);
  readonly targetListId = signal<string | null>(null);
  readonly pointer = signal<{ x: number; y: number } | null>(null);
  private cursorTarget: { element: HTMLElement; value: string; priority: string } | null = null;
  private readonly onPointerOver = (event: PointerEvent) => {
    const target = event.composedPath().find((node): node is HTMLElement => node instanceof HTMLElement);
    if (target) this.setCursorTarget(target);
  };

  start(sourceListId: string, sourceElement?: HTMLElement): void {
    this.sourceListId.set(sourceListId);
    this.targetListId.set(null);
    this.pointer.set(null);
    this.active.set(true);
    // The preview ignores pointer events. Change only the hit element's cursor rather than
    // invalidating every descendant with `body.is-card-dragging *` on large boards. Pointerover
    // follows native hit testing, so this adds no layout reads or overlay that can block CDK.
    if (sourceElement) this.setCursorTarget(sourceElement);
    document.addEventListener("pointerover", this.onPointerOver, { capture: true, passive: true });
    document.body.classList.add("is-card-dragging");
    // The board still owns page-level edge-scroll setup. Keep one compatibility event for that
    // surface while list/directive fanout moves onto route-independent signals.
    document.dispatchEvent(new CustomEvent<boolean>(APP_DOM_EVENTS.CARD_DRAG_STATE, { detail: true }));
  }

  move(pointer: { x: number; y: number }): void {
    this.pointer.set(pointer);
  }

  target(listId: string | null): void {
    this.targetListId.set(listId);
  }

  end(): void {
    if (!this.active()) return;
    this.active.set(false);
    this.sourceListId.set(null);
    this.targetListId.set(null);
    this.pointer.set(null);
    document.removeEventListener("pointerover", this.onPointerOver, true);
    this.restoreCursorTarget();
    document.body.classList.remove("is-card-dragging");
    document.dispatchEvent(new CustomEvent<boolean>(APP_DOM_EVENTS.CARD_DRAG_STATE, { detail: false }));
  }

  private setCursorTarget(element: HTMLElement): void {
    if (this.cursorTarget?.element === element) return;
    this.restoreCursorTarget();
    this.cursorTarget = { element, value: element.style.getPropertyValue("cursor"), priority: element.style.getPropertyPriority("cursor") };
    element.style.setProperty("cursor", "grabbing", "important");
  }

  private restoreCursorTarget(): void {
    const target = this.cursorTarget;
    if (!target) return;
    if (target.value) target.element.style.setProperty("cursor", target.value, target.priority);
    else target.element.style.removeProperty("cursor");
    this.cursorTarget = null;
  }
}
