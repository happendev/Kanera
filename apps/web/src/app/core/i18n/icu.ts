/**
 * ICU plural/select for messages written in TypeScript.
 *
 * Templates get ICU from Angular's compiler, but `$localize` only substitutes `${}` placeholders: an
 * ICU expression in its text reaches the translator as plain text and comes back translated, still
 * unevaluated. `icu()` evaluates it, so a translator can use every plural category their language
 * needs (Japanese only "other", Polish "one/few/many/other") without a code change:
 *
 *   icu($localize`:Card count:{count, plural, one {# card} other {# cards}}`, { count });
 *
 * Supported: `{name}` arguments, `{name, plural, ...}` with `=N` and CLDR categories, `#` for the
 * count inside a plural case, `{name, select, ...}`, and nesting. Apostrophe quoting is not
 * supported; write a literal apostrophe as-is.
 */
import { appLocale } from "./locale";

type Values = Record<string, string | number | null | undefined>;

const pluralRules = new Map<string, Intl.PluralRules>();
const numberFormats = new Map<string, Intl.NumberFormat>();

function pluralCategory(count: number): Intl.LDMLPluralRule {
  const locale = appLocale();
  let rules = pluralRules.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRules.set(locale, rules);
  }
  return rules.select(count);
}

function formatNumber(count: number): string {
  const locale = appLocale();
  let format = numberFormats.get(locale);
  if (!format) {
    format = new Intl.NumberFormat(locale);
    numberFormats.set(locale, format);
  }
  return format.format(count);
}

/** Index just past the `}` that closes the `{` at `open`. */
function closingBrace(message: string, open: number): number {
  let depth = 0;
  for (let i = open; i < message.length; i += 1) {
    if (message[i] === "{") depth += 1;
    else if (message[i] === "}" && --depth === 0) return i + 1;
  }
  throw new Error(`Unbalanced braces in ICU message: ${message}`);
}

/** Splits "one {..} other {..}" into [key, body] pairs. */
function cases(source: string): [string, string][] {
  const result: [string, string][] = [];
  let i = 0;
  while (i < source.length) {
    const open = source.indexOf("{", i);
    if (open === -1) break;
    const key = source.slice(i, open).trim();
    const end = closingBrace(source, open);
    result.push([key, source.slice(open + 1, end - 1)]);
    i = end;
  }
  return result;
}

function evaluate(message: string, values: Values, count: number | null): string {
  let out = "";
  let i = 0;
  while (i < message.length) {
    const char = message[i]!;
    if (char === "#" && count !== null) {
      out += formatNumber(count);
      i += 1;
      continue;
    }
    if (char !== "{") {
      out += char;
      i += 1;
      continue;
    }
    const end = closingBrace(message, i);
    const inner = message.slice(i + 1, end - 1);
    const match = /^\s*([A-Za-z0-9_]+)\s*(?:,\s*(plural|select)\s*,([\s\S]*))?$/.exec(inner);
    if (!match) {
      out += message.slice(i, end);
    } else if (!match[2]) {
      out += String(values[match[1]!] ?? "");
    } else {
      out += evaluateExpression(match[1]!, match[2], match[3]!, values);
    }
    i = end;
  }
  return out;
}

function evaluateExpression(name: string, kind: string, body: string, values: Values): string {
  const value = values[name];
  const options = cases(body.replace(/^\s*offset:\d+/, ""));
  const pick = (key: string) => options.find(([candidate]) => candidate === key)?.[1];
  if (kind === "select") {
    const chosen = pick(String(value)) ?? pick("other") ?? "";
    return evaluate(chosen, values, null);
  }
  const count = Number(value ?? 0);
  const chosen = pick(`=${count}`) ?? pick(pluralCategory(count)) ?? pick("other") ?? "";
  return evaluate(chosen, values, count);
}

/** Evaluates the ICU expressions in a (translated) message. See the file header. */
export function icu(message: string, values: Values): string {
  return evaluate(message, values, null);
}
