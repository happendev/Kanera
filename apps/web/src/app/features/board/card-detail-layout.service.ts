import { computed, Injectable, signal } from "@angular/core";
import { STORAGE_KEYS } from "../../core/browser/browser-contracts";

export type CardDetailMode = "panel" | "modal";

// Below this width the side-panel layout is too cramped, so we drop the
// panel/modal choice entirely and force modal. Matches Tailwind's `lg`
// breakpoint (1024px); 1023.98px so the boundary pixel still counts as "below".
const BELOW_LG_QUERY = "(max-width: 1023.98px)";

@Injectable({ providedIn: "root" })
export class CardDetailLayoutService {
  private readonly _mode = signal<CardDetailMode>(this.getInitial());
  // The user's stored preference. Drives the toggle button state when the
  // choice is available; below lg it is overridden by `effectiveMode`.
  readonly mode = this._mode.asReadonly();

  private readonly belowLg = signal(this.matchesBelowLg());

  // The mode the card detail actually renders in. Below lg the panel option is
  // removed and we always render as a modal, regardless of stored preference.
  readonly effectiveMode = computed<CardDetailMode>(() => (this.belowLg() ? "modal" : this._mode()));

  // The panel/modal toggle is only offered when the panel layout is viable
  // (>= lg). Below that, hide the control so the forced modal is unambiguous.
  readonly canToggle = computed(() => !this.belowLg());

  constructor() {
    window.addEventListener("storage", (event) => {
      if (event.key !== STORAGE_KEYS.CARD_DETAIL_MODE) return;
      this._mode.set(this.isMode(event.newValue) ? event.newValue : "panel");
    });

    if (typeof window.matchMedia === "function") {
      const mql = window.matchMedia(BELOW_LG_QUERY);
      mql.addEventListener("change", (event) => this.belowLg.set(event.matches));
    }
  }

  toggle() {
    // Guard against toggling while the choice is hidden (e.g. a stray keybind);
    // modal is forced below lg and the preference must not silently flip.
    if (this.belowLg()) return;
    const next: CardDetailMode = this._mode() === "modal" ? "panel" : "modal";
    this.setMode(next);
  }

  setMode(next: CardDetailMode) {
    this._mode.set(next);
    localStorage.setItem(STORAGE_KEYS.CARD_DETAIL_MODE, next);
  }

  private getInitial(): CardDetailMode {
    const stored = localStorage.getItem(STORAGE_KEYS.CARD_DETAIL_MODE);
    if (this.isMode(stored)) return stored;
    return "panel";
  }

  private isMode(value: string | null): value is CardDetailMode {
    return value === "panel" || value === "modal";
  }

  private matchesBelowLg(): boolean {
    return typeof window.matchMedia === "function" && window.matchMedia(BELOW_LG_QUERY).matches;
  }
}
