import { Injectable, computed, signal } from "@angular/core";
import { STORAGE_KEYS } from "../browser/browser-contracts";

// Density is a device preference, not an account one: the same person wants roomier rows on a
// phone and tighter ones on a 27" monitor, so unlike theme and accent it never reaches /auth/me.
// It stamps [data-density] on <html> (the index.html pre-paint script does the same from storage so
// the sidebar does not jump at boot) and stylesheets branch on that attribute with
// `:host-context([data-density="compact"])`. Only sizing is allowed to change under it; colour,
// contrast and touch targets stay as the theme and pointer rules set them.
const DENSITIES = ["comfortable", "compact"] as const;
export type Density = (typeof DENSITIES)[number];

@Injectable({ providedIn: "root" })
export class DensityService {
  private readonly _density = signal<Density>(readDensity());
  readonly density = this._density.asReadonly();
  readonly compact = computed(() => this._density() === "compact");

  constructor() {
    this.apply(this._density());
    window.addEventListener("storage", (event) => {
      // Another tab on this device changed the preference. Mirror it without re-writing storage,
      // which would bounce the event back.
      if (event.key === STORAGE_KEYS.DENSITY) {
        const next = isDensity(event.newValue) ? event.newValue : "comfortable";
        this._density.set(next);
        this.apply(next);
      }
    });
  }

  setDensity(next: Density) {
    if (next === this._density()) return;
    this._density.set(next);
    this.apply(next);
    try {
      if (next === "comfortable") localStorage.removeItem(STORAGE_KEYS.DENSITY);
      else localStorage.setItem(STORAGE_KEYS.DENSITY, next);
    } catch {
      // Storage can be unavailable in private or restricted browser contexts.
    }
  }

  private apply(density: Density) {
    if (density === "comfortable") delete document.documentElement.dataset["density"];
    else document.documentElement.dataset["density"] = density;
  }
}

function isDensity(value: string | null): value is Density {
  return (DENSITIES as readonly string[]).includes(value ?? "");
}

function readDensity(): Density {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.DENSITY);
    return isDensity(stored) ? stored : "comfortable";
  } catch {
    return "comfortable";
  }
}
