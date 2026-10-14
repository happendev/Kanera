#!/usr/bin/env node
// Translation workflow for the web app. See src/locale/README.md.
//
//   node scripts/i18n.mjs extract                      Re-extract src/locale/messages.arb from the code
//   node scripts/i18n.mjs check [--skip-extract]       Fail if messages.arb is stale or any language is
//                                                      incomplete or has broken placeholders (runs in lint)
//   node scripts/i18n.mjs status                       Translated/missing counts per language
//   node scripts/i18n.mjs todo <locale> [--limit N] [--file SUBSTR[,SUBSTR...]] [--all]
//                                                      Print untranslated messages as JSON, with context
//   node scripts/i18n.mjs merge <locale> <file.json>   Merge {"id": "translation"} after validating each
//   node scripts/i18n.mjs prune                        Drop translations whose message no longer exists
//
// messages.arb is the source catalog (UK English) with each message's description and the files that
// use it. messages.<locale>.json holds one language in the {locale, translations} shape that
// @angular/localize's loadTranslations() reads at runtime.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localeDir = join(webRoot, "src/locale");
const sourcePath = join(localeDir, "messages.arb");
const sharedLocales = readFileSync(join(webRoot, "../../packages/shared/src/locales.ts"), "utf8");
const LOCALES = JSON.parse(`[${/export const LOCALES = \[([^\]]+)\]/.exec(sharedLocales)[1]}]`);
const SOURCE_LOCALE = /export const SOURCE_LOCALE = "([^"]+)"/.exec(sharedLocales)[1];
const TARGET_LOCALES = LOCALES.filter((locale) => locale !== SOURCE_LOCALE);

const localePath = (locale) => join(localeDir, `messages.${locale}.json`);

function fail(message) {
  console.error(message);
  process.exit(1);
}

// ---------------------------------------------------------------------------------------------------
// Source catalog

/** Runs Angular's extractor into `outDir` and returns the normalised catalog. */
function runExtractor(outDir) {
  execFileSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["ng", "extract-i18n", "--format", "arb", "--output-path", outDir, "--out-file", "messages.arb", "--progress=false"],
    { cwd: webRoot, stdio: ["ignore", "ignore", "inherit"] },
  );
  return normaliseArb(JSON.parse(readFileSync(join(outDir, "messages.arb"), "utf8")));
}

// Line and column numbers churn on every edit, so only the file list is kept: enough for a translator
// to find the screen, stable enough to keep diffs to real copy changes.
function normaliseArb(raw) {
  const catalog = { "@@locale": SOURCE_LOCALE };
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith("@")) continue;
    catalog[key] = value;
    const meta = raw[`@${key}`] ?? {};
    const files = [...new Set((meta["x-locations"] ?? []).map((location) => location.file))].sort();
    const out = {};
    if (meta.description) out.description = meta.description;
    if (meta.meaning) out.meaning = meta.meaning;
    if (files.length) out["x-files"] = files;
    catalog[`@${key}`] = out;
  }
  return catalog;
}

function readSource() {
  if (!existsSync(sourcePath)) fail(`${sourcePath} is missing; run "node scripts/i18n.mjs extract".`);
  const catalog = JSON.parse(readFileSync(sourcePath, "utf8"));
  const messages = new Map();
  for (const [key, value] of Object.entries(catalog)) {
    if (key.startsWith("@")) continue;
    const meta = catalog[`@${key}`] ?? {};
    messages.set(key, { id: key, source: value, description: meta.description, meaning: meta.meaning, files: meta["x-files"] ?? [] });
  }
  return messages;
}

const serialise = (value) => `${JSON.stringify(value, null, 2)}\n`;

// ---------------------------------------------------------------------------------------------------
// Translation files

function readLocale(locale) {
  if (!existsSync(localePath(locale))) return {};
  return JSON.parse(readFileSync(localePath(locale), "utf8")).translations ?? {};
}

/** Writes in source-catalog order so diffs stay readable and reviewable. */
function writeLocale(locale, translations, messages) {
  const ordered = {};
  for (const id of messages.keys()) if (id in translations) ordered[id] = translations[id];
  const tmp = `${localePath(locale)}.tmp`;
  writeFileSync(tmp, serialise({ locale, translations: ordered }));
  renameSync(tmp, localePath(locale));
}

// Several translators (or agents) can merge into one language at once; a directory lock serialises
// the read-modify-write so no batch is lost.
function withLock(locale, fn) {
  const lock = join(localeDir, `.lock-${locale}`);
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      if (Date.now() > deadline) fail(`Timed out waiting for ${lock}; delete it if no merge is running.`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------
// Validation: a translation must keep every placeholder and the ICU structure of its source.

/**
 * Every placeholder and ICU argument a message references, sorted: `{$NAME}` placeholders from
 * templates and `$localize`, `{NAME}` placeholders inside ICU cases, `{name}` arguments in messages
 * formatted with icu(), and `name:plural` / `name:select` for each ICU expression. ICU case bodies
 * (the `{...}` after `one` or `=0`) are text, not references.
 */
function placeholderTokens(text) {
  const refs = [];
  const stack = [];
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === "}") {
      stack.pop();
      i += 1;
      continue;
    }
    if (char !== "{") {
      i += 1;
      continue;
    }
    if (stack.at(-1) === "cases") {
      stack.push("text");
      i += 1;
      continue;
    }
    const match = /^\{\s*(\$?[A-Za-z0-9_]+)\s*(\}|,\s*(plural|select|selectordinal)\s*,)/.exec(text.slice(i));
    if (match?.[2] === "}") {
      refs.push(match[1]);
      i += match[0].length;
    } else if (match) {
      refs.push(`${match[1]}:${match[3]}`);
      stack.push("cases");
      i += match[0].length;
    } else {
      stack.push("text");
      i += 1;
    }
  }
  // A set, not a multiset: a language with fewer plural categories legitimately repeats a
  // placeholder fewer times (Japanese keeps only "other").
  return [...new Set(refs)].sort();
}

function bracesBalanced(text) {
  let depth = 0;
  for (const char of text) {
    if (char === "{") depth += 1;
    else if (char === "}" && --depth < 0) return false;
  }
  return depth === 0;
}

/** Top-level ICU expressions: [{ name, kind, cases: string[] }]. */
function icuShape(text) {
  const shapes = [];
  const pattern = /\{\s*([A-Za-z0-9_]+)\s*,\s*(plural|select|selectordinal)\s*,/g;
  let match;
  while ((match = pattern.exec(text))) {
    const cases = [];
    let i = pattern.lastIndex;
    let depth = 1;
    let key = "";
    while (i < text.length && depth > 0) {
      const char = text[i];
      if (char === "{") {
        if (depth === 1) {
          cases.push(key.trim());
          key = "";
        }
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
      } else if (depth === 1) {
        key += char;
      }
      i += 1;
    }
    shapes.push({ name: match[1], kind: match[2], cases });
  }
  return shapes;
}

function validate(source, translation) {
  if (typeof translation !== "string" || !translation.trim()) return "empty translation";
  const expected = placeholderTokens(source);
  const actual = placeholderTokens(translation);
  if (expected.join() !== actual.join()) {
    return `placeholders differ: expected ${expected.join(" ") || "none"}, got ${actual.join(" ") || "none"}`;
  }
  if (!bracesBalanced(translation)) return "unbalanced braces";
  const sourceIcu = icuShape(source);
  const translationIcu = icuShape(translation);
  if (sourceIcu.length !== translationIcu.length) return `expected ${sourceIcu.length} ICU expression(s), got ${translationIcu.length}`;
  for (const [index, shape] of sourceIcu.entries()) {
    const other = translationIcu[index];
    if (shape.name !== other.name || shape.kind !== other.kind) return `ICU ${index} must stay {${shape.name}, ${shape.kind}, ...}`;
    // Plural categories legitimately differ by language (Japanese has only "other"); select keys are
    // values from the code and must match exactly.
    if (shape.kind === "select" && shape.cases.join() !== other.cases.join()) return `select cases must stay ${shape.cases.join(", ")}`;
    if (shape.kind !== "select" && !other.cases.includes("other")) return "plural must keep an \"other\" case";
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------
// Commands

function extract() {
  const outDir = mkdtempSync(join(tmpdir(), "kanera-i18n-"));
  try {
    const catalog = runExtractor(outDir);
    writeFileSync(sourcePath, serialise(catalog));
    const count = Object.keys(catalog).filter((key) => !key.startsWith("@")).length;
    console.log(`Extracted ${count} messages to src/locale/messages.arb.`);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
  status();
}

function check(args) {
  const problems = [];
  if (!args.includes("--skip-extract")) {
    const outDir = mkdtempSync(join(tmpdir(), "kanera-i18n-"));
    try {
      const fresh = serialise(runExtractor(outDir));
      const committed = existsSync(sourcePath) ? readFileSync(sourcePath, "utf8") : "";
      if (fresh !== committed) problems.push("src/locale/messages.arb is out of date: run `pnpm i18n:extract` and translate the new messages.");
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }
  const messages = readSource();
  for (const locale of TARGET_LOCALES) {
    const translations = readLocale(locale);
    const missing = [...messages.keys()].filter((id) => !(id in translations));
    const stale = Object.keys(translations).filter((id) => !messages.has(id));
    const invalid = [];
    for (const [id, text] of Object.entries(translations)) {
      const message = messages.get(id);
      const error = message && validate(message.source, text);
      if (error) invalid.push(`${id} (${error})`);
    }
    if (missing.length) problems.push(`${locale}: ${missing.length} untranslated (node scripts/i18n.mjs todo ${locale}), e.g. ${missing.slice(0, 3).join(", ")}`);
    if (stale.length) problems.push(`${locale}: ${stale.length} obsolete (node scripts/i18n.mjs prune)`);
    for (const entry of invalid.slice(0, 20)) problems.push(`${locale}: invalid ${entry}`);
    if (invalid.length > 20) problems.push(`${locale}: ...and ${invalid.length - 20} more invalid`);
  }
  if (problems.length) fail(`i18n check failed:\n  ${problems.join("\n  ")}`);
  console.log(`i18n check passed: ${messages.size} messages, ${TARGET_LOCALES.length} languages complete.`);
}

function status() {
  const messages = readSource();
  for (const locale of TARGET_LOCALES) {
    const translations = readLocale(locale);
    const done = [...messages.keys()].filter((id) => id in translations).length;
    console.log(`${locale.padEnd(6)} ${String(done).padStart(5)} / ${messages.size} translated, ${messages.size - done} missing`);
  }
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function todo([locale, ...args]) {
  if (!TARGET_LOCALES.includes(locale)) fail(`Usage: todo <${TARGET_LOCALES.join("|")}> [--limit N] [--file SUBSTR] [--all]`);
  const messages = readSource();
  const translations = readLocale(locale);
  const file = option(args, "--file");
  const limit = Number(option(args, "--limit") ?? 200);
  const all = args.includes("--all");
  const rows = [...messages.values()]
    .filter((message) => all || !(message.id in translations))
    .filter((message) => !file || file.split(",").some((part) => message.files.some((path) => path.includes(part))))
    .slice(0, limit)
    .map(({ id, source, description, meaning, files }) => ({
      id,
      source,
      ...(meaning ? { meaning } : {}),
      ...(description ? { description } : {}),
      files: files.map((path) => path.replace(/^src\/app\//, "")),
      ...(all && id in translations ? { current: translations[id] } : {}),
    }));
  process.stdout.write(serialise(rows));
}

function merge([locale, file]) {
  if (!TARGET_LOCALES.includes(locale) || !file) fail("Usage: merge <locale> <file.json>  (file holds {\"id\": \"translation\"})");
  const incoming = JSON.parse(readFileSync(resolve(process.cwd(), file), "utf8"));
  const messages = readSource();
  const rejected = [];
  let accepted = 0;
  withLock(locale, () => {
    const translations = readLocale(locale);
    for (const [id, text] of Object.entries(incoming)) {
      const message = messages.get(id);
      if (!message) {
        rejected.push(`${id}: unknown message id`);
        continue;
      }
      const error = validate(message.source, text);
      if (error) {
        rejected.push(`${id}: ${error}\n    source: ${message.source}\n    got:    ${text}`);
        continue;
      }
      // Inline whitespace at the edges belongs to the layout, not the language: keep the source's.
      const lead = /^\s*/.exec(message.source)[0];
      const trail = /\s*$/.exec(message.source)[0];
      translations[id] = `${lead}${text.trim()}${trail}`;
      accepted += 1;
    }
    writeLocale(locale, translations, messages);
  });
  console.log(`${locale}: merged ${accepted}, rejected ${rejected.length}.`);
  if (rejected.length) {
    console.log(rejected.map((line) => `  ${line}`).join("\n"));
    process.exitCode = 1;
  }
}

function prune() {
  const messages = readSource();
  for (const locale of TARGET_LOCALES) {
    withLock(locale, () => {
      const translations = readLocale(locale);
      const before = Object.keys(translations).length;
      writeLocale(locale, translations, messages);
      const after = Object.keys(readLocale(locale)).length;
      if (before !== after) console.log(`${locale}: removed ${before - after} obsolete translations.`);
    });
  }
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case "extract": extract(); break;
  case "check": check(rest); break;
  case "status": status(); break;
  case "todo": todo(rest); break;
  case "merge": merge(rest); break;
  case "prune": prune(); break;
  default: fail("Usage: node scripts/i18n.mjs <extract|check|status|todo|merge|prune> (see the header of this file)");
}
