import zhCN from "./zh-CN.js";
import zhTW from "./zh-TW.js";
import nl from "./nl.js";
import nb from "./nb.js";
import type { Locale } from "@kanera/shared/locales";
import de from "./de.js";
import enGB from "./en-GB.js";
import enUS from "./en-US.js";
import es from "./es.js";
import fr from "./fr.js";
import ja from "./ja.js";
import ptBR from "./pt-BR.js";
import type { ServerMessages } from "./types.js";

/**
 * One catalog per supported language. Typed as a full `Record<Locale, …>` so adding a tag to
 * `LOCALES` without a catalog here fails type-checking.
 */
const CATALOGS: Record<Locale, ServerMessages> = {
  "en-GB": enGB,
  "en-US": enUS,
  es,
  "pt-BR": ptBR,
  fr,
  de,
  ja,
  nl,
  nb,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
};

/** The email and push wording for `locale`. Resolve the locale first (see ../request-locale.ts). */
export function serverMessages(locale: Locale): ServerMessages {
  return CATALOGS[locale];
}
