import { Injectable, Injector, computed, inject, signal } from "@angular/core";
import { ACCENTS, THEMES, type Accent, type Theme } from "@kanera/shared/appearance";
import { ApiClient } from "../api/api.client";
import { AuthService } from "../auth/auth.service";
import { STORAGE_KEYS } from "../browser/browser-contracts";

// THEMES and ACCENTS live in @kanera/shared because they are also a database value domain: both are
// columns on `user` with matching CHECK constraints, so the vocabulary has to be one list. They sit
// in their own dependency-free module rather than @kanera/shared/schema — importing the schema
// barrel would pull Drizzle into the browser bundle.
export type { Accent, Theme };

// Themes come in two families, each with a default and a neutral alternative: dark/carbon and
// light/paper. Anything that used to branch on `theme() === "dark"` must branch on `isDark()`
// instead, or the alternatives render the wrong chrome — logos, icons and the palette toggle all
// read the family, not the exact value. Adding a theme means adding it to the shared tuple, to the
// matching family list below, to the index.html pre-paint script, and to a token block in
// styles.scss.
const DARK_THEMES = ["dark", "carbon"] as const;
export type DarkTheme = (typeof DARK_THEMES)[number];

// The accent (primary) colour is chosen independently of the theme, so a user who likes carbon's
// canvas is not stuck with its blue. "default" keeps each theme's own signature accent — teal on
// light/dark, blue on carbon, sienna on paper — and the named options retint it. Each named option
// ships one value per theme *family* in styles.scss, both verified at >= 4.5:1 as a fill carrying
// --accent-ink and as text on --bg/--surface/--surface-2 in all four themes; the accent doubles as
// link and label text here, so a single hue has to clear both. Adding one means adding it to the
// shared tuple, to ACCENT_OPTIONS, to the index.html pre-paint script, and to the `[data-accent]`
// blocks plus the per-family `--accent-<name>` tokens in styles.scss.

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
  // Resolved lazily in persist(). ThemeService is constructed during bootstrap to paint the first
  // frame, and ApiClient pulls in the socket layer behind it; taking both eagerly would put that
  // on the boot path for a service that usually never writes.
  private readonly injector = inject(Injector);

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
    this.applyThemeChoice(next);
    // A theme change can drag the accent with it; send both in one request rather than two.
    const swapped = this.reconcileAccent(next);
    this.persist(swapped ? { theme: next, accent: swapped } : { theme: next });
  }

  setAccent(next: Accent) {
    this.applyAccentChoice(next);
    this.persist({ accent: next });
  }

  /**
   * Adopt the appearance stored on the account. The account is the source of truth; localStorage is
   * only the cache index.html paints from before Angular boots.
   *
   * A null value means the account has never chosen. What that falls back to depends on whose
   * values are currently cached on this device:
   *
   *  - the same user's (or nobody's, on a fresh device or after a signed-out toggle) — keep them,
   *    so signing in on a new machine never pushes that machine's default over a choice made
   *    elsewhere, and the login page's own theme toggle survives signing in;
   *  - a *different* user's — reset to the OS preference and the default accent, or the previous
   *    person's theme would silently become the new one's. That is the case where an account with
   *    an accent but no theme looked like "only the accent applied".
   *
   * Nothing here writes to the account, so this stays safe to call from an effect on the session,
   * which re-fires on every unrelated user change.
   */
  hydrate(userId: string | null | undefined, theme: string | null | undefined, accent: string | null | undefined) {
    if (!userId) return;
    const inherited = this.appearanceOwner() !== null && this.appearanceOwner() !== userId;

    const nextTheme = theme ?? null;
    if (this.isTheme(nextTheme)) this.applyThemeChoice(nextTheme);
    else if (inherited) this.applyThemeChoice(this.osTheme());

    const nextAccent = accent ?? null;
    if (this.isAccent(nextAccent)) this.applyAccentChoice(nextAccent);
    else if (inherited) this.applyAccentChoice("default");

    // The stored pair can still be one this theme does not offer; correct it locally and let the
    // account catch up on the user's next change rather than writing during a read.
    this.reconcileAccent(this._theme());
    localStorage.setItem(STORAGE_KEYS.APPEARANCE_OWNER, userId);
  }

  /**
   * Return the device to a neutral appearance when a session ends. Appearance belongs to the
   * account, so leaving the previous person's theme painted on the login screen — and on whoever
   * signs in next without a stored preference of their own — is wrong.
   *
   * This is the live path. hydrate()'s owner check is the other half, covering the case this one
   * cannot see: a session that expired while the tab was closed, where nothing ever observes the
   * sign-out and the cache is still sitting there on the next cold start.
   */
  reset() {
    this.applyThemeChoice(this.osTheme());
    this.applyAccentChoice("default");
    // Drop the cache rather than write the neutral values into it: with nothing stored, the
    // index.html pre-paint falls back to the OS preference, which is the right answer for whoever
    // opens this browser next.
    localStorage.removeItem(STORAGE_KEYS.THEME);
    localStorage.removeItem(STORAGE_KEYS.ACCENT);
    localStorage.removeItem(STORAGE_KEYS.APPEARANCE_OWNER);
  }

  // Blue and Green are one slot, so a theme change has to move the selection with it: switching to
  // carbon on Blue lands on Green, and switching back returns to Blue. Without this the user keeps
  // an accent the picker no longer offers — on carbon, one indistinguishable from its default.
  // Returns the accent it swapped to, so the caller can fold it into a single write.
  private reconcileAccent(theme: Theme): Accent | null {
    const cool = THEME_COOL_ACCENT[theme];
    const current = this._accent();
    if (!isCoolAccent(current) || current === cool) return null;
    this.applyAccentChoice(cool);
    return cool;
  }

  private applyThemeChoice(next: Theme) {
    if (next === this._theme()) return;
    this._theme.set(next);
    this.remember(next);
    this.apply(next);
  }

  private applyAccentChoice(next: Accent) {
    if (next === this._accent()) return;
    this._accent.set(next);
    this.applyAccent(next);
  }

  private appearanceOwner(): string | null {
    return localStorage.getItem(STORAGE_KEYS.APPEARANCE_OWNER);
  }

  private persist(patch: { theme?: Theme; accent?: Accent }) {
    const auth = this.injector.get(AuthService);
    const userId = auth.user()?.id;
    // The login page carries a theme toggle, so a signed-out change is normal: it stays on the
    // device and the account picks it up whenever the user next changes something while signed in.
    if (!userId) return;
    // Choosing takes ownership of the device cache, so the next person to sign in here is not
    // handed this appearance as their own.
    localStorage.setItem(STORAGE_KEYS.APPEARANCE_OWNER, userId);
    void this.injector
      .get(ApiClient)
      .patch("/auth/me", patch)
      // Keep the cached session in step, or a reload would hydrate the pre-change value back over
      // what the user just picked.
      .then(() => auth.updateUser((user) => ({ ...user, ...patch })))
      // Deliberately no rollback and no error surface: the change is already painted and cached
      // locally, and yanking the theme back mid-use on a dropped request is worse than letting the
      // account catch up on the next change.
      .catch(() => undefined);
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
    return this.isTheme(stored) ? stored : this.osTheme();
  }

  /** The theme with nothing chosen anywhere — what an account with no stored theme falls back to. */
  private osTheme(): Theme {
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
