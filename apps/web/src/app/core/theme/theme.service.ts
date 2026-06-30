import { Injectable, signal } from "@angular/core";
import { STORAGE_KEYS } from "../browser/browser-contracts";

type Theme = "light" | "dark";

@Injectable({ providedIn: "root" })
export class ThemeService {
  private readonly _theme = signal<Theme>(this.getInitial());
  readonly theme = this._theme.asReadonly();

  constructor() {
    this.apply(this._theme());
    window.addEventListener("storage", (event) => {
      if (event.key !== STORAGE_KEYS.THEME || !this.isTheme(event.newValue)) return;
      this._theme.set(event.newValue);
      document.documentElement.dataset["theme"] = event.newValue;
    });
  }

  toggle() {
    const next: Theme = this._theme() === "dark" ? "light" : "dark";
    this.setTheme(next);
  }

  setTheme(next: Theme) {
    this._theme.set(next);
    this.apply(next);
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
    return value === "light" || value === "dark";
  }
}
