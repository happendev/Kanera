import type { FastifyRequest } from "fastify";
import { isLocale, matchLocale, parseAcceptLanguage, SOURCE_LOCALE, type Locale } from "@kanera/shared/locales";

/**
 * The language a response should be written in. The web app sends its interface language as
 * `Accept-Language` on every request (core/i18n/locale.ts), so this is the language on screen, even
 * before sign-in; other clients get their browser or tool default, then the source language.
 */
export function requestLocale(req: Pick<FastifyRequest, "headers">): Locale {
  const header = req.headers["accept-language"];
  return matchLocale(parseAcceptLanguage(Array.isArray(header) ? header.join(",") : header)) ?? SOURCE_LOCALE;
}

/**
 * The language to write to a person in when there is no request to ask: mail, push and other
 * background delivery. Null is an account that never chose (see `users.locale`).
 */
export function recipientLocale(stored: string | null | undefined): Locale {
  return isLocale(stored) ? stored : SOURCE_LOCALE;
}

/**
 * The language to write to an account while handling a request (a password reset, a welcome email):
 * the language it chose, else the language the requester's screen is showing.
 */
export function accountLocale(stored: string | null | undefined, req: Pick<FastifyRequest, "headers">): Locale {
  return isLocale(stored) ? stored : requestLocale(req);
}
