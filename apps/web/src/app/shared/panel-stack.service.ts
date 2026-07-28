import type { OnDestroy } from "@angular/core";
import { Injectable } from "@angular/core";

/** Why a layer is being asked to close. Vetoes can care about the difference. */
export type PanelDismissReason = "outside-pointer" | "escape" | "superseded";

export type PanelLayer = {
  /**
   * The panel's root element. Optional: a layer with no element (the card-detail drawer, its
   * checklist-item pane) still takes part in Escape ordering but never closes on an outside click,
   * because "outside" is meaningless for something that has no box of its own.
   */
  hostEl?: HTMLElement | null;
  /**
   * Extra regions that count as "inside" this layer — typically the trigger's wrapper, so clicking a
   * toggle button does not race its own panel's outside-click dismissal.
   */
  keepOpenWithin?: () => readonly (HTMLElement | null | undefined)[];
  /** Return false to refuse a dismissal, e.g. while an inline confirmation is showing. */
  canDismiss?: (reason: PanelDismissReason) => boolean;
  dismiss: (reason: PanelDismissReason) => void;
};

type Registration = PanelLayer & {
  /** The layer this one opened from, derived at registration time by DOM containment. */
  parent: Registration | null;
  /** Dismissal removes a layer immediately; its Angular view may remain mounted until the next render. */
  active: boolean;
};

/**
 * Arbitrates dismissal across every open anchored panel.
 *
 * This replaces the hardcoded class allowlists that board table and calendar views used to
 * carry: nesting is derived from the DOM at registration time, so a picker opened from inside a menu
 * automatically protects the menu underneath it and nobody has to remember to add its class anywhere.
 *
 * The service holds the arbitration and capture-phase document listeners (inherently global state);
 * `AnchoredPanelDirective` owns each panel's placement and registration. Registration order is open
 * order, so the last-registered layer is the innermost.
 */
@Injectable({ providedIn: "root" })
export class PanelStackService implements OnDestroy {
  private readonly layers: Registration[] = [];
  private listening = false;
  private readonly onDocumentClick = (event: Event) => this.handlePointer(event);
  private readonly onDocumentContextMenu = (event: Event) => this.handlePointer(event);
  private readonly onDocumentEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape") this.handleEscape(event);
  };

  /** Registers a layer and returns its unregister function. */
  register(layer: PanelLayer): () => void {
    const parent = this.findContainer(layer.hostEl);
    const registration: Registration = { ...layer, parent, active: true };

    // Opening a panel closes anything that is not part of its own opener chain. Two unrelated menus
    // open at once reads as a bug, and relying on the opening click to dismiss the old one is
    // unreliable: most triggers still call `stopPropagation`, so that click never reaches the stack.
    // Ancestors are spared — a nested picker must not close the menu it was opened from.
    // Element-less layers are skipped for the same reason they are skipped for outside clicks: a
    // keyboard-only layer such as the card-detail drawer has no box, so containment can never place a
    // new panel "inside" it and it would be closed by every picker opened within the card.
    const spared = new Set<Registration>();
    for (let ancestor = parent; ancestor; ancestor = ancestor.parent) spared.add(ancestor);

    // Descendants are spared too, and adopted. A nested panel can register *before* the one it sits
    // inside: Angular runs `ngAfterViewInit` child-first, so a menu and a submenu made visible in the
    // same change-detection pass arrive submenu-first. Without this the submenu would look unrelated
    // when the menu registered a moment later, and be superseded instantly. Only orphans are
    // re-parented, so a deeper layer keeps the nearer ancestor it already found.
    if (layer.hostEl) {
      for (const open of this.layers) {
        if (!open.hostEl || !layer.hostEl.contains(open.hostEl)) continue;
        if (open.parent === null) open.parent = registration;
        spared.add(open);
      }
    }

    // Superseding is the one non-vetoable reason: allowing the old layer to refuse while the new one
    // registers would violate the app-wide one-unrelated-panel invariant.
    this.dismissAll("superseded", (open) => !spared.has(open) && !!open.hostEl);

    this.layers.push(registration);
    this.refreshStacking();
    this.startListening();
    return () => {
      this.remove(registration);
    };
  }

  /** Number of open layers. Exposed for tests and dev diagnostics. */
  get depth(): number {
    return this.layers.length;
  }

  /**
   * Close every open panel, for a surface that opens *without* registering a layer of its own — a
   * drawer, or a toolbar that expands in flow. Those cannot rely on `register()`'s supersede rule, and
   * hand-listing the popovers they should close is how the old cross-close matrices drifted out of
   * date. Element-less layers are spared, as everywhere else.
   */
  closeAll(): void {
    this.dismissAll("superseded", (layer) => !!layer.hostEl);
  }

  /** A pointer event anywhere in the document: dismiss every layer it did not happen inside. */
  handlePointer(event: Event): void {
    const path = eventPath(event);
    // Innermost-first, so the deepest containing layer wins; its whole opener chain is then protected,
    // which is what keeps a nested picker from closing the menu it was opened from. A click inside a
    // submenu is inside its parent menu's element too, so taking the first hit in a shallower order
    // would protect the parent and dismiss the submenu the click actually landed in.
    const hit = this.innermostFirst().find((layer) => isInside(layer, path)) ?? null;
    const kept = new Set<Registration>();
    for (let layer = hit; layer; layer = layer.parent) kept.add(layer);

    this.dismissAll("outside-pointer", (layer) => !kept.has(layer) && !!layer.hostEl);
  }

  /** Escape closes exactly one layer: the innermost. Outer layers keep their turn for the next press. */
  handleEscape(event: Event): void {
    const top = this.innermostFirst()[0];
    if (!top) return;

    // The innermost layer owns this keypress whether or not it chooses to close, so nothing outside
    // the stack (a page-level Escape handler) also reacts to it.
    event.stopPropagation();
    if (top.canDismiss && !top.canDismiss("escape")) return;
    this.remove(top, true);
    top.dismiss("escape");
  }

  private dismissAll(reason: PanelDismissReason, predicate: (layer: Registration) => boolean): void {
    // The snapshot matters because dismissal removes each layer before calling into its component.
    // Innermost-first means an outer layer can never be removed ahead of a still-open child.
    for (const layer of this.innermostFirst()) {
      if (!predicate(layer)) continue;
      if (reason !== "superseded" && layer.canDismiss && !layer.canDismiss(reason)) continue;
      this.remove(layer, true);
      layer.dismiss(reason);
    }
  }

  /**
   * Open layers innermost-first — nesting depth, then most-recently-opened within a depth.
   *
   * Reverse registration order is *nearly* the same thing and used to stand in for it, but not when a
   * nested panel registers before the one it sits inside (see `register`). Ordering by the opener chain
   * instead is what keeps "Escape closes the innermost", "a click inside a submenu protects it", and
   * "children are dismissed before their parent" true regardless of arrival order.
   */
  private innermostFirst(): Registration[] {
    const depth = (layer: Registration): number => {
      let n = 0;
      for (let ancestor = layer.parent; ancestor; ancestor = ancestor.parent) n++;
      return n;
    };
    // Reversed first so that, at equal depth, the most recently opened layer comes first — `sort` is
    // stable, so it preserves that within a depth.
    return [...this.layers].filter((layer) => layer.active).reverse().sort((a, b) => depth(b) - depth(a));
  }

  /** The innermost open layer whose element contains `el` — i.e. the layer `el` was opened from. */
  private findContainer(el: HTMLElement | null | undefined): Registration | null {
    if (!el) return null;
    return (
      this.innermostFirst()
        .find((layer) => layer.hostEl && layer.hostEl !== el && layer.hostEl.contains(el)) ?? null
    );
  }

  private remove(layer: Registration, hideImmediately = false): void {
    if (!layer.active) return;
    layer.active = false;
    // Angular removes an `@if` view on the following render. Hide a dismissed layer now so it cannot
    // paint over (or intercept a click intended for) the replacement panel during that same tick.
    if (hideImmediately && layer.hostEl) layer.hostEl.classList.remove("is-positioned");
    // A view can unregister its parent before Angular destroys nested child views. Keep any surviving
    // child attached to the nearest still-active ancestor so depth and outside-click protection do not
    // retain a stale registration.
    for (const child of this.layers) {
      if (child.parent === layer) child.parent = layer.parent?.active ? layer.parent : null;
    }
    const index = this.layers.indexOf(layer);
    if (index >= 0) this.layers.splice(index, 1);
    this.refreshStacking();
    if (this.layers.length === 0) this.stopListening();
  }

  /**
   * Give every open DOM layer a deterministic paint order. A nested fixed panel lives inside its
   * parent's stacking context, so sharing the exact same z-index can leave a border or menu row over
   * the child at their touching edges. Opener order plus nesting depth keeps the child on top.
   */
  private refreshStacking(): void {
    const depth = (layer: Registration): number => {
      let n = 0;
      for (let ancestor = layer.parent; ancestor; ancestor = ancestor.parent) n++;
      return n;
    };
    const order = [...this.layers]
      .filter((layer) => layer.active && !!layer.hostEl)
      .sort((a, b) => depth(a) - depth(b) || this.layers.indexOf(a) - this.layers.indexOf(b));
    order.forEach((layer, index) => {
      layer.hostEl?.style.setProperty("z-index", `calc(var(--z-panel, 300) + ${index})`);
    });
  }

  /**
   * Capture phase is load-bearing: cards, picker triggers and other controls legitimately stop
   * bubbling. An open panel must still see those clicks as outside before the target acts.
   */
  private startListening(): void {
    if (this.listening || typeof document === "undefined") return;
    document.addEventListener("click", this.onDocumentClick, true);
    document.addEventListener("contextmenu", this.onDocumentContextMenu, true);
    document.addEventListener("keydown", this.onDocumentEscape, true);
    this.listening = true;
  }

  private stopListening(): void {
    if (!this.listening || typeof document === "undefined") return;
    document.removeEventListener("click", this.onDocumentClick, true);
    document.removeEventListener("contextmenu", this.onDocumentContextMenu, true);
    document.removeEventListener("keydown", this.onDocumentEscape, true);
    this.listening = false;
  }

  ngOnDestroy(): void {
    this.stopListening();
    this.layers.length = 0;
  }
}

/**
 * `composedPath()` is the reliable way to ask "did this happen inside that element": it is captured
 * at dispatch time, so it still answers correctly for a click on a node the handler has since
 * removed from the DOM (a menu row that closes its own menu). Falls back to walking up from the
 * target for synthetic events without it.
 */
function eventPath(event: Event): readonly EventTarget[] {
  if (typeof event.composedPath === "function") {
    const path = event.composedPath();
    if (path.length) return path;
  }
  const path: EventTarget[] = [];
  for (let node = event.target as Node | null; node; node = node.parentNode) path.push(node);
  return path;
}

function isInside(layer: PanelLayer, path: readonly EventTarget[]): boolean {
  const regions = [layer.hostEl, ...(layer.keepOpenWithin?.() ?? [])];
  return regions.some((region) => !!region && path.includes(region));
}
