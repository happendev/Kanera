// Interface-language vocabulary, shared by the Drizzle column, the Zod DTOs, the web locale loader
// and the API's email/push catalogs so TypeScript, request validation and the database CHECK
// constraint cannot drift.
//
// Tags are BCP 47 and double as the `Intl` locale for dates and numbers, so "en-GB" gets day-first
// dates and "en-US" month-first. Adding a language means: add its tag and native name here, add a
// web translation file (apps/web/src/locale/messages.<tag>.json, see apps/web/src/locale/README.md)
// and add an API catalog (apps/api/src/lib/i18n/messages/<tag>.ts). The type checker and
// `pnpm i18n:check` name everything still missing.
export const LOCALES = ["en-US", "en-GB", "es", "pt-BR", "fr", "de", "ja", "nl", "nb", "zh-CN", "zh-TW"] as const;
export type Locale = (typeof LOCALES)[number];

// The language the product copy is written in. Untranslated text renders in this language, and it is
// what server-side mail falls back to for an account that has never chosen one.
export const SOURCE_LOCALE = "en-GB" satisfies Locale;

// Each language names itself, so someone who cannot read the current interface can still find theirs.
export const LOCALE_NATIVE_NAMES: Record<Locale, string> = {
  "en-US": "English (US)",
  "en-GB": "English (UK)",
  es: "Español",
  "pt-BR": "Português (Brasil)",
  fr: "Français",
  de: "Deutsch",
  ja: "日本語",
  nl: "Nederlands",
  nb: "Norsk (bokmål)",
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/**
 * Best supported locale for a list of BCP 47 preferences (navigator.languages, or a parsed
 * Accept-Language header), or null when none match.
 *
 * An exact tag wins ("pt-BR"); otherwise the base language picks its regional default ("pt-PT" reads
 * Brazilian Portuguese, "es-MX" reads Spanish). English regions other than the US read UK English,
 * which is closer to Commonwealth spelling and date order than US English is.
 */
export function matchLocale(preferences: readonly string[]): Locale | null {
  for (const raw of preferences) {
    const tag = raw.trim();
    if (!tag) continue;
    const exact = LOCALES.find((locale) => locale.toLowerCase() === tag.toLowerCase());
    if (exact) return exact;
    const [language, region] = tag.toLowerCase().split(/[-_]/);
    if (language === "en") return region === "us" ? "en-US" : region ? "en-GB" : "en-US";
    if (language === "pt") return "pt-BR";
    // Norwegian browser preferences often use the macrolanguage tag rather than Bokmål.
    if (language === "no") return "nb";
    if (language === "zh") {
      const subtags = tag.toLowerCase().split(/[-_]/).slice(1);
      // An explicit script wins over the region, including Hans-HK and Hant-CN preferences.
      if (subtags.includes("hans")) return "zh-CN";
      if (subtags.includes("hant")) return "zh-TW";
      return subtags.some((part) => ["tw", "hk", "mo"].includes(part)) ? "zh-TW" : "zh-CN";
    }
    const base = LOCALES.find((locale) => locale.toLowerCase() === language);
    if (base) return base;
  }
  return null;
}

/** Parses an Accept-Language header into tags ordered by quality, highest first. */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      return { tag: tag?.trim() ?? "", quality: q ? Number(q.slice(2)) || 0 : 1, index };
    })
    .filter((entry) => entry.tag && entry.tag !== "*" && entry.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index)
    .map((entry) => entry.tag);
}
