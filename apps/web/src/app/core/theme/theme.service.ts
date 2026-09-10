import { Injectable, computed, signal } from "@angular/core";
import { STORAGE_KEYS } from "../browser/browser-contracts";

// Themes come in two families, each with a default and a neutral alternative: dark/carbon and
// light/paper. Anything that used to branch on `theme() === "dark"` must branch on `isDark()`
// instead, or the alternatives render the wrong chrome — logos, icons and the palette toggle all
// read the family, not the exact value. Adding a theme means adding it here, to the matching
// family list, to the index.html pre-paint script, and to a token block in styles.scss.
const THEMES = ["light", "paper", "dark", "carbon"] as const;
const DARK_THEMES = ["dark", "carbon"] as const;
export type Theme = (typeof THEMES)[number];
export type DarkTheme = (typeof DARK_THEMES)[number];

export function isDarkTheme(theme: Theme): theme is DarkTheme {
  return (DARK_THEMES as readonly Theme[]).includes(theme);
}

@Injectable({ providedIn: "root" })
export class ThemeService {
  private readonly _theme = signal<Theme>(this.getInitial());
  readonly theme = this._theme.asReadonly();

  /** True for every dark-family theme. Prefer this over comparing against "dark". */
  readonly isDark = computed(() => isDarkTheme(this._theme()));

  // Which theme in each family the light/dark toggle returns to. Toggling away from an
  // alternative and back must land on that alternative again, not silently demote the user to
  // the family default.
  private lastDark: DarkTheme = "dark";
  private lastLight: Theme = "light";

  constructor() {
    const initial = this._theme();
    this.remember(initial);
    this.apply(initial);
    window.addEventListener("storage", (event) => {
      if (event.key !== STORAGE_KEYS.THEME || !this.isTheme(event.newValue)) return;
      this._theme.set(event.newValue);
      this.remember(event.newValue);
      document.documentElement.dataset["theme"] = event.newValue;
    });
  }

  toggle() {
    this.setTheme(this.isDark() ? this.lastLight : this.lastDark);
  }

  setTheme(next: Theme) {
    this._theme.set(next);
    this.remember(next);
    this.apply(next);
  }

  private remember(theme: Theme) {
    if (isDarkTheme(theme)) this.lastDark = theme;
    else this.lastLight = theme;
  }

  private apply(t: Theme) {
    document.documentElement.dataset["theme"] = t;
    localStorage.setItem(STORAGE_KEYS.THEME, t);
  }

  private getInitial(): Theme {
    const stored = localStorage.getItem(STORAGE_KEYS.THEME);
    if (this.isTheme(stored)) return stored;
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }

  private isTheme(value: string | null): value is Theme {
    return THEMES.includes(value as Theme);
  }
}
