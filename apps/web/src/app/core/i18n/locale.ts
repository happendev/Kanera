/**
 * Interface language for this page load.
 *
 * Kanera uses Angular's own i18n (`i18n` attributes in templates, `$localize` in TypeScript) in
 * runtime mode: one build serves every language, and `main.ts` loads the chosen translations before
 * any application code is evaluated. Messages are resolved once, when their template or module first
 * runs, so a language change reloads the page rather than re-rendering in place.
 *
 * The account's `locale` is the source of truth (it is what mail and push are written in). This
 * device keeps a copy in localStorage so the next load, including the signed-out pages, starts in the
 * right language before `/me` answers. See apps/web/src/locale/README.md for adding a language.
 */
import { registerLocaleData } from "@angular/common";
import { loadTranslations } from "@angular/localize";
import { isLocale, matchLocale, SOURCE_LOCALE, type Locale } from "@kanera/shared/locales";
import { STORAGE_KEYS } from "../browser/browser-contracts";

interface TranslationFile {
  locale: string;
  translations: Record<string, string>;
}

type TranslatedLocale = Exclude<Locale, typeof SOURCE_LOCALE>;

// Each translation is its own hashed chunk, so a viewer downloads only their language. The source
// language (UK English) is compiled into the templates and needs no file.
const TRANSLATIONS: Record<TranslatedLocale, () => Promise<TranslationFile>> = {
  "en-US": () => import("../../../locale/messages.en-US.json").then((m) => m.default),
  es: () => import("../../../locale/messages.es.json").then((m) => m.default),
  "pt-BR": () => import("../../../locale/messages.pt-BR.json").then((m) => m.default),
  fr: () => import("../../../locale/messages.fr.json").then((m) => m.default),
  de: () => import("../../../locale/messages.de.json").then((m) => m.default),
  ja: () => import("../../../locale/messages.ja.json").then((m) => m.default),
  nl: () => import("../../../locale/messages.nl.json").then((m) => m.default),
  nb: () => import("../../../locale/messages.nb.json").then((m) => m.default),
  "zh-CN": () => import("../../../locale/messages.zh-CN.json").then((m) => m.default),
  "zh-TW": () => import("../../../locale/messages.zh-TW.json").then((m) => m.default),
};

// Angular's own locale data, for the few framework pipes that read LOCALE_ID. Everything Kanera
// formats itself goes through `Intl` with `appLocale()` (see shared/date-format.ts). "en-US" ships
// with Angular; Angular's "pt" is Brazilian Portuguese.
const ANGULAR_LOCALE_DATA: Record<Exclude<Locale, "en-US">, () => Promise<{ default: unknown }>> = {
  "en-GB": () => import("@angular/common/locales/en-GB"),
  es: () => import("@angular/common/locales/es"),
  "pt-BR": () => import("@angular/common/locales/pt"),
  fr: () => import("@angular/common/locales/fr"),
  de: () => import("@angular/common/locales/de"),
  ja: () => import("@angular/common/locales/ja"),
  nl: () => import("@angular/common/locales/nl"),
  nb: () => import("@angular/common/locales/nb"),
  "zh-CN": () => import("@angular/common/locales/zh"),
  "zh-TW": () => import("@angular/common/locales/zh-Hant"),
};

let active: Locale = SOURCE_LOCALE;

/** The language this page load is rendering in. Pass it to every `Intl` constructor. */
export function appLocale(): Locale {
  return active;
}

function storedLocale(): Locale | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.LOCALE);
    return isLocale(stored) ? stored : null;
  } catch {
    return null;
  }
}

/** The browser's preferred supported language, used until the account has chosen one. */
function browserLocale(): Locale {
  if (typeof navigator === "undefined") return SOURCE_LOCALE;
  const preferences = navigator.languages?.length ? navigator.languages : [navigator.language];
  return matchLocale(preferences) ?? SOURCE_LOCALE;
}

function rememberLocale(locale: Locale): void {
  try {
    localStorage.setItem(STORAGE_KEYS.LOCALE, locale);
  } catch {
    // Storage is optional; the account copy still applies once /me loads.
  }
}

/**
 * Loads the translations for this device's language. Must finish before the application module
 * graph is imported, because messages are read when their module or template first evaluates.
 */
export async function initLocale(): Promise<Locale> {
  const locale = storedLocale() ?? browserLocale();
  try {
    if (locale !== SOURCE_LOCALE) {
      const file = await TRANSLATIONS[locale]();
      loadTranslations(file.translations);
    }
    if (locale !== "en-US") registerLocaleData((await ANGULAR_LOCALE_DATA[locale]()).default, locale);
    active = locale;
    try { sessionStorage.removeItem(RELOAD_ATTEMPT_KEY); } catch { /* Storage is optional. */ }
  } catch (error) {
    // A missing chunk (offline before the service worker cached it, or a deploy mid-session) must
    // not stop the app from booting; the source language is always available.
    console.warn(`[Kanera] Could not load the "${locale}" translations; continuing in ${SOURCE_LOCALE}.`, error);
    active = SOURCE_LOCALE;
    registerLocaleData((await ANGULAR_LOCALE_DATA[SOURCE_LOCALE]()).default, SOURCE_LOCALE);
  }
  $localize.locale = active;
  if (typeof document !== "undefined") document.documentElement.lang = active;
  return active;
}

let reloading = false;
// Session-scoped (per tab), so a language whose translations cannot load reloads once, not forever.
const RELOAD_ATTEMPT_KEY = "kanera-locale-reload";

/**
 * Switches this page to `locale`. Translations are resolved when code first runs, so the only way to
 * re-render everything in the new language is a fresh load.
 */
export function applyLocale(locale: Locale): void {
  rememberLocale(locale);
  if (locale === active || reloading || typeof location === "undefined") return;
  try {
    if (sessionStorage.getItem(RELOAD_ATTEMPT_KEY) === locale) return;
    sessionStorage.setItem(RELOAD_ATTEMPT_KEY, locale);
  } catch {
    // Without session storage there is no loop guard, but a failed load is rare enough to accept it.
  }
  reloading = true;
  location.reload();
}

/**
 * `locale`'s name in the language on screen ("Spanish" while reading English), or null when it would
 * only repeat the native name: the same language family, or a runtime without `Intl.DisplayNames`.
 */
export function languageName(locale: Locale): string | null {
  if (locale.split("-")[0] === active.split("-")[0]) return null;
  try {
    return new Intl.DisplayNames([active], { type: "language" }).of(locale) ?? null;
  } catch {
    return null;
  }
}
