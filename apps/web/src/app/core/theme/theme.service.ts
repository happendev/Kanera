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

// The accent (primary) colour is chosen independently of the theme, so a user who likes carbon's
// canvas is not stuck with its blue. "default" keeps each theme's own signature accent — teal on
// light/dark, blue on carbon, sienna on paper — and the named options retint it. Each named option
// ships one value per theme *family* in styles.scss, both verified at >= 4.5:1 as a fill carrying
// --accent-ink and as text on --bg/--surface/--surface-2 in all four themes; the accent doubles as
// link and label text here, so a single hue has to clear both. Adding one means adding it here, to
// ACCENT_OPTIONS, to the index.html pre-paint script, and to the `[data-accent]` blocks plus the
// per-family `--accent-<name>` tokens in styles.scss.
const ACCENTS = ["default", "blue", "green", "violet", "pink", "graphite"] as const;
export type Accent = (typeof ACCENTS)[number];

// Blue and Green share one slot rather than each having their own, so every theme offers five
// options. Which of the two appears is decided by the theme's own accent: carbon is already a blue,
// and offering Blue there gave two swatches a user could not tell apart, so carbon offers Green
// instead. The remaining themes are teal (dark, light) and sienna (paper), where Blue is the more
// distinct of the pair. See reconcileAccent(): the *selection* moves with the slot too.
type CoolAccent = Extract<Accent, "blue" | "green">;
const THEME_COOL_ACCENT: Record<Theme, CoolAccent> = {
  dark: "blue",
  light: "blue",
  paper: "blue",
  carbon: "green",
};

// `token` is the CSS custom property holding this option's tone for the *current* theme, so the
// settings swatches preview the colour the user will actually get rather than a hardcoded hex.
// Order is the display order; filtering out the unused cool option preserves it.
export const ACCENT_OPTIONS: readonly { value: Accent; label: string; token: string }[] = [
  { value: "default", label: "Default", token: "--accent-default" },
  { value: "blue", label: "Blue", token: "--accent-blue" },
  { value: "green", label: "Green", token: "--accent-green" },
  { value: "violet", label: "Violet", token: "--accent-violet" },
  { value: "pink", label: "Pink", token: "--accent-pink" },
  { value: "graphite", label: "Graphite", token: "--accent-graphite" },
];

function isCoolAccent(accent: Accent): accent is CoolAccent {
  return accent === "blue" || accent === "green";
}

export function isDarkTheme(theme: Theme): theme is DarkTheme {
  return (DARK_THEMES as readonly Theme[]).includes(theme);
}

@Injectable({ providedIn: "root" })
export class ThemeService {
  private readonly _theme = signal<Theme>(this.getInitial());
  readonly theme = this._theme.asReadonly();

  private readonly _accent = signal<Accent>(this.getInitialAccent());
  readonly accent = this._accent.asReadonly();

  /** True for every dark-family theme. Prefer this over comparing against "dark". */
  readonly isDark = computed(() => isDarkTheme(this._theme()));

  /** The five accent options offered under the current theme, in display order. */
  readonly accentOptions = computed(() => {
    const cool = THEME_COOL_ACCENT[this._theme()];
    return ACCENT_OPTIONS.filter((option) => !isCoolAccent(option.value) || option.value === cool);
  });

  // Which theme in each family the light/dark toggle returns to. Toggling away from an
  // alternative and back must land on that alternative again, not silently demote the user to
  // the family default.
  private lastDark: DarkTheme = "dark";
  private lastLight: Theme = "light";

  constructor() {
    const initial = this._theme();
    this.remember(initial);
    this.apply(initial);
    this.applyAccent(this._accent());
    // Storage can hold a combination this theme no longer offers — the theme was changed in another
    // tab, or the stored pair predates a change to THEME_COOL_ACCENT.
    this.reconcileAccent(initial);
    window.addEventListener("storage", (event) => {
      // Another tab on this device changed the preference. Mirror it without re-writing storage,
      // which would bounce the event back.
      if (event.key === STORAGE_KEYS.THEME && this.isTheme(event.newValue)) {
        this._theme.set(event.newValue);
        this.remember(event.newValue);
        document.documentElement.dataset["theme"] = event.newValue;
        return;
      }
      if (event.key === STORAGE_KEYS.ACCENT && this.isAccent(event.newValue)) {
        this._accent.set(event.newValue);
        document.documentElement.dataset["accent"] = event.newValue;
      }
    });
  }

  toggle() {
    this.setTheme(this.isDark() ? this.lastLight : this.lastDark);
  }

  setTheme(next: Theme) {
    this._theme.set(next);
    this.remember(next);
    this.apply(next);
    this.reconcileAccent(next);
  }

  setAccent(next: Accent) {
    this._accent.set(next);
    this.applyAccent(next);
  }

  // Blue and Green are one slot, so a theme change has to move the selection with it: switching to
  // carbon on Blue lands on Green, and switching back returns to Blue. Without this the user keeps
  // an accent the picker no longer offers — on carbon, one indistinguishable from its default.
  private reconcileAccent(theme: Theme) {
    const cool = THEME_COOL_ACCENT[theme];
    const current = this._accent();
    if (isCoolAccent(current) && current !== cool) this.setAccent(cool);
  }

  private remember(theme: Theme) {
    if (isDarkTheme(theme)) this.lastDark = theme;
    else this.lastLight = theme;
  }

  private apply(t: Theme) {
    document.documentElement.dataset["theme"] = t;
    localStorage.setItem(STORAGE_KEYS.THEME, t);
  }

  private applyAccent(a: Accent) {
    // Always stamp the attribute, "default" included: the `[data-accent]` blocks in styles.scss
    // are what a non-default choice needs, and writing the default explicitly keeps the DOM and
    // the stored preference readable rather than relying on an absent attribute.
    document.documentElement.dataset["accent"] = a;
    localStorage.setItem(STORAGE_KEYS.ACCENT, a);
  }

  private getInitial(): Theme {
    const stored = localStorage.getItem(STORAGE_KEYS.THEME);
    if (this.isTheme(stored)) return stored;
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }

  private getInitialAccent(): Accent {
    const stored = localStorage.getItem(STORAGE_KEYS.ACCENT);
    return this.isAccent(stored) ? stored : "default";
  }

  private isTheme(value: string | null): value is Theme {
    return THEMES.includes(value as Theme);
  }

  private isAccent(value: string | null): value is Accent {
    return ACCENTS.includes(value as Accent);
  }
}
