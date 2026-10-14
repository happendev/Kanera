import { z } from "zod";
import { SOURCE_LOCALE, type Locale } from "@kanera/shared/locales";
import { translateErrorMessage } from "./errors/translate.js";

const maps = {
  "en-GB": z.locales.en().localeError,
  "en-US": z.locales.en().localeError,
  es: z.locales.es().localeError,
  "pt-BR": z.locales.pt().localeError,
  fr: z.locales.fr().localeError,
  de: z.locales.de().localeError,
  ja: z.locales.ja().localeError,
  nl: z.locales.nl().localeError,
  nb: z.locales.no().localeError,
  "zh-CN": z.locales.zhCN().localeError,
  "zh-TW": z.locales.zhTW().localeError,
} satisfies Record<Locale, z.core.$ZodErrorMap>;

/** Format per request: changing Zod's global locale would race between different recipients. */
export function localizeIssues(issues: z.core.$ZodIssue[], locale: Locale): z.core.$ZodIssue[] {
  return issues.map((issue) => {
    const translated = translateErrorMessage(issue.message, locale);
    // Public issues omit input; locale formatters only need the issue metadata.
    const formatted = maps[locale](issue as z.core.$ZodRawIssue);
    // App-specific refinements use the error catalog; Zod handles built-in length, URL, type,
    // enum and range rules. Unknown custom checks still get a readable localized fallback.
    const message = locale === SOURCE_LOCALE || locale === "en-US" || translated !== issue.message
      ? translated
      : typeof formatted === "string" ? formatted : formatted?.message ?? translateErrorMessage("validation failed", locale);
    const localized = { ...issue, message };
    if (localized.code === "invalid_union" && !("matches" in localized)) {
      return { ...localized, errors: localized.errors.map((nested) => localizeIssues(nested, locale)) };
    }
    if (localized.code === "invalid_key" || localized.code === "invalid_element") {
      return { ...localized, issues: localizeIssues(localized.issues, locale) };
    }
    return localized;
  });
}
