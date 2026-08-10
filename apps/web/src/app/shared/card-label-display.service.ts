import { Injectable, signal } from "@angular/core";
import { STORAGE_KEYS } from "../core/browser/browser-contracts";

/**
 * The app-wide "labels are compressed to colour dots" preference, backed by localStorage.
 *
 * Split out of `BoardMenuCoordinator` deliberately, and the split is the whole point: the menu half
 * owns a `document` listener whose teardown must run on route leave, which is why that service is
 * route-scoped and NOT `providedIn: "root"`. This half owns a `window "storage"` listener for a
 * localStorage-backed global preference — app-lifetime is exactly the right scope for it, since the
 * preference outlives every route and the listener has nothing to tear down.
 *
 * It is also the only way a *shell* surface can render the same label chips a board does. The Up
 * next drawer lives outside every route that provides `BoardMenuCoordinator`, so `k-card-labels`
 * would throw a NullInjectorError there. Providing the coordinator on the queue component instead
 * would shadow the route instance and let one surface's compressed state drift from the page's.
 */
@Injectable({ providedIn: "root" })
export class CardLabelDisplayService {
  readonly labelsCompressed = signal(readLabelsCompressed());

  constructor() {
    // Another tab toggling the preference must not leave this one disagreeing about a shared,
    // durably-stored choice.
    window.addEventListener("storage", (event: StorageEvent) => {
      if (event.key === STORAGE_KEYS.CARD_LABELS_COMPRESSED) {
        this.labelsCompressed.set(event.newValue === "1");
      }
    });
  }

  setLabelsCompressed(compressed: boolean) {
    this.labelsCompressed.set(compressed);
    try {
      if (compressed) localStorage.setItem(STORAGE_KEYS.CARD_LABELS_COMPRESSED, "1");
      else localStorage.removeItem(STORAGE_KEYS.CARD_LABELS_COMPRESSED);
    } catch {
      // Storage can be unavailable in private or restricted browser contexts.
    }
  }
}

function readLabelsCompressed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEYS.CARD_LABELS_COMPRESSED) === "1";
  } catch {
    return false;
  }
}
