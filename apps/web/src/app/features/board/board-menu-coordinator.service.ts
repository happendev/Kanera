import type { OnDestroy } from "@angular/core";
import type { WritableSignal } from "@angular/core";
import { inject, Injectable, signal, untracked } from "@angular/core";
import { APP_DOM_EVENTS } from "../../core/browser/browser-contracts";
import { CardLabelDisplayService } from "../../shared/card-label-display.service";

/**
 * Coordinates the mutually-exclusive card/list menus, and re-exports the shared label display
 * preference that `CardLabelDisplayService` now owns.
 *
 * Board and Global Work provide a route-local instance (see their component `providers`). Keeping
 * the native listeners here means a 1,000-card board installs one listener per event instead of one
 * listener per rendered card. Intentionally NOT `providedIn: "root"`: this owns a document listener
 * torn down in ngOnDestroy, and only a component-scoped provider guarantees that teardown runs on
 * route leave. A root singleton would leak that listener.
 *
 * The label preference is the opposite case — localStorage-backed, app-lifetime, and needed by shell
 * chrome outside any route that provides this service — so it lives in the root service and is
 * delegated here for the call sites that already read it through the coordinator.
 */
@Injectable()
export class BoardMenuCoordinator implements OnDestroy {
  private readonly labelDisplay = inject(CardLabelDisplayService);

  readonly activeCardMenuId = signal<string | null>(null);
  readonly activeListMenuId = signal<string | null>(null);
  readonly labelsCompressed = this.labelDisplay.labelsCompressed;
  private readonly cardMenuStates = new Map<string, WritableSignal<boolean>>();

  // The calendar view still dispatches CARD_ACTIONS_MENU_OPEN as a DOM event rather than calling the
  // coordinator directly, so this bridge keeps its card menu mutually exclusive with the others.
  // (Kanban and table cards now call openCardMenu directly.) LIST_MENU_OPEN and
  // CARD_LABELS_DISPLAY_CHANGED no longer have any dispatcher — list menus call openListMenu directly
  // and the label preference is this shared signal — so they are not bridged.
  private readonly onCardMenuEvent = (event: Event) => {
    const cardId = event instanceof CustomEvent && typeof event.detail === "string" ? event.detail : null;
    if (cardId) this.openCardMenu(cardId);
    else this.closeCardMenu();
  };

  constructor() {
    document.addEventListener(APP_DOM_EVENTS.CARD_ACTIONS_MENU_OPEN, this.onCardMenuEvent);
  }

  openCardMenu(cardId: string) {
    const previousCardId = this.activeCardMenuId();
    if (previousCardId !== cardId) this.cardMenuStates.get(previousCardId ?? "")?.set(false);
    this.activeListMenuId.set(null);
    this.activeCardMenuId.set(cardId);
    this.cardMenuStates.get(cardId)?.set(true);
  }

  closeCardMenu(cardId?: string) {
    const activeCardId = this.activeCardMenuId();
    if (cardId !== undefined && activeCardId !== cardId) return;
    this.cardMenuStates.get(activeCardId ?? "")?.set(false);
    this.activeCardMenuId.set(null);
  }

  openListMenu(listId: string) {
    this.closeCardMenu();
    this.activeListMenuId.set(listId);
  }

  closeListMenu(listId?: string) {
    if (listId === undefined || this.activeListMenuId() === listId) this.activeListMenuId.set(null);
  }

  registerCardMenu(cardId: string, open: WritableSignal<boolean>): () => void {
    this.cardMenuStates.set(cardId, open);
    // Registration runs inside each card's setup effect. Read the coordinator state untracked so
    // opening a menu does not rerun that effect and unregister the menu it just opened.
    open.set(untracked(() => this.activeCardMenuId()) === cardId);
    return () => {
      if (this.cardMenuStates.get(cardId) !== open) return;
      this.cardMenuStates.delete(cardId);
      if (this.activeCardMenuId() === cardId) this.activeCardMenuId.set(null);
    };
  }

  setLabelsCompressed(compressed: boolean) {
    this.labelDisplay.setLabelsCompressed(compressed);
  }

  ngOnDestroy() {
    document.removeEventListener(APP_DOM_EVENTS.CARD_ACTIONS_MENU_OPEN, this.onCardMenuEvent);
  }
}
