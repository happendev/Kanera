import { Injectable, signal } from "@angular/core";
import { APP_DOM_EVENTS } from "../../core/browser/browser-contracts";

@Injectable({ providedIn: "root" })
export class CardDragCoordinator {
  readonly active = signal(false);
  readonly sourceListId = signal<string | null>(null);
  readonly targetListId = signal<string | null>(null);
  readonly pointer = signal<{ x: number; y: number } | null>(null);

  start(sourceListId: string): void {
    this.sourceListId.set(sourceListId);
    this.targetListId.set(null);
    this.pointer.set(null);
    this.active.set(true);
    // The CDK preview ignores pointer events, so the cursor comes from whichever board element is
    // underneath it. Mark the document for the whole gesture to keep the grabbing cursor stable as
    // the pointer crosses cards, gaps, lists, and page chrome.
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
    document.body.classList.remove("is-card-dragging");
    document.dispatchEvent(new CustomEvent<boolean>(APP_DOM_EVENTS.CARD_DRAG_STATE, { detail: false }));
  }
}
