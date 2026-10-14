import { zhCN } from "./zh-CN.js";
import { zhTW } from "./zh-TW.js";
import { nl } from "./nl.js";
import { nb } from "./nb.js";
import { SOURCE_LOCALE, type Locale } from "@kanera/shared/locales";
import { de } from "./de.js";
import { enUS } from "./en-US.js";
import { es } from "./es.js";
import { fr } from "./fr.js";
import { ja } from "./ja.js";
import { ptBR } from "./pt-BR.js";
import { ERROR_MESSAGES, type ErrorCatalog, type ErrorMessageKey } from "./source.js";

// The source language needs no catalog: its keys are the messages themselves. US English only lists
// spelling differences, so it is Partial; every other language must translate every key.
const CATALOGS: Record<Exclude<Locale, typeof SOURCE_LOCALE>, Partial<ErrorCatalog>> = {
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

/** `{name}` in a catalog key or translation. `{1,9}` (a regex quantifier in one message) is not one. */
const PLACEHOLDER = /\{([A-Za-z_]\w*)\}/g;

interface MessagePattern {
  key: ErrorMessageKey;
  regex: RegExp;
  names: string[];
}

const EXACT = new Set<string>(ERROR_MESSAGES);

// Keys with placeholders match messages built from template literals. Each placeholder captures
// lazily and the whole message is anchored, so "{field} not found" never matches inside a longer
// message. When two patterns match the same message ("{type} anchor not found" and "{field} not
// found", or "cards[{index}]: {message}" wrapping "card not found"), the more specific one is tried
// first: the longer fixed opening, then the more fixed text overall.
const PATTERNS: MessagePattern[] = ERROR_MESSAGES.flatMap((key) => {
  const names = [...key.matchAll(PLACEHOLDER)].map((match) => match[1]!);
  if (names.length === 0) return [];
  const literals = key.split(PLACEHOLDER).filter((_, index) => index % 2 === 0);
  const source = literals.map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("(.+?)");
  return [{ key, regex: new RegExp(`^${source}$`, "s"), names }];
}).sort((a, b) => fixedPrefix(b.key) - fixedPrefix(a.key) || fixedText(b.key) - fixedText(a.key));

function fixedPrefix(key: string): number {
  return key.split(PLACEHOLDER)[0]!.length;
}

function fixedText(key: string): number {
  return key.replace(PLACEHOLDER, "").length;
}

/**
 * The client-facing error message in `locale`. Messages are matched against the English catalog:
 * exact keys first, then the parameterised keys, whose captured values are carried into the
 * translation unchanged (a captured `{message}` is itself an error message and is translated too).
 * Anything not in the catalog is returned as is, so an untranslated message still reads in English.
 */
export function translateErrorMessage(message: string, locale: Locale): string {
  if (locale === SOURCE_LOCALE) return message;
  const catalog = CATALOGS[locale];
  if (EXACT.has(message)) return catalog[message as ErrorMessageKey] ?? message;
  for (const pattern of PATTERNS) {
    const match = pattern.regex.exec(message);
    if (!match) continue;
    const values = new Map(pattern.names.map((name, index) => {
      const value = match[index + 1]!;
      return [name, name === "message" ? translateErrorMessage(value, locale) : value];
    }));
    const template = catalog[pattern.key] ?? pattern.key;
    return template.replace(PLACEHOLDER, (whole, name: string) => values.get(name) ?? whole);
  }
  return message;
}
