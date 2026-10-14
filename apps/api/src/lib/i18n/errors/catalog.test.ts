import { zhCN } from "./zh-CN.js";
import { zhTW } from "./zh-TW.js";
import { nl } from "./nl.js";
import { nb } from "./nb.js";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { de } from "./de.js";
import { enUS } from "./en-US.js";
import { es } from "./es.js";
import { fr } from "./fr.js";
import { ja } from "./ja.js";
import { ptBR } from "./pt-BR.js";
import { ERROR_MESSAGES, type ErrorCatalog } from "./source.js";
import { translateErrorMessage } from "./translate.js";

// Failure this catches: a new error string thrown through the AppError helpers ships to users in
// English only, because nothing else notices it is missing from the catalog. E2E cannot see it.

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const PLACEHOLDER = /\{([A-Za-z_]\w*)\}/g;
const STRING_ARG = String.raw`(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|\`((?:[^\`\\]|\\.)*)\`)`;
const ERROR_CALLS = [
  new RegExp(String.raw`\b(?:badRequest|forbidden|notFound|conflict|unauthorized|tooManyRequests)\(\s*${STRING_ARG}`, "g"),
  new RegExp(String.raw`\bnew AppError\(\s*[^,]+,\s*[^,]+,\s*${STRING_ARG}`, "g"),
];
// Template messages with no fixed wording of their own: the interpolated text is already a message.
const UNTRANSLATABLE_TEMPLATES = new Set(["${formatIssuePath(path)}: ${message}"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") && !/\.(test|itest)\.ts$/.test(entry.name) ? [path] : [];
  });
}

function thrownMessages(): { text: string; template: boolean; file: string }[] {
  return sourceFiles(SRC).flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return ERROR_CALLS.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => {
      const template = match[3] !== undefined && match[3].includes("${");
      return { text: (match[1] ?? match[2] ?? match[3])!, template, file: relative(SRC, file) };
    }));
  });
}

function placeholders(text: string): string {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[1]).sort().join(",");
}

void test("every literal error message thrown in src is in the error catalog", () => {
  const keys = new Set<string>(ERROR_MESSAGES);
  const found = thrownMessages();
  assert.ok(found.length > 300, `scanner found only ${found.length} messages; are the regexes still right?`);
  const missing = found.filter((message) => !message.template && !keys.has(message.text));
  assert.deepEqual(missing.map((m) => `${m.file}: ${m.text}`), [], "add these to src/lib/i18n/errors/source.ts and translate them");
});

void test("every template error message thrown in src has a parameterised catalog key", () => {
  const found = thrownMessages().filter((message) => message.template && !UNTRANSLATABLE_TEMPLATES.has(message.text));
  const missing = found.filter((message) => {
    // `${…}` in the source may stand for any text, so a key covers the template when the key's own
    // text (its {placeholders} or fixed wording such as "boards") fits where each `${…}` sits.
    const fixed = message.text.split(/\$\{[^}]*\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const shape = new RegExp(`^${fixed.join("[\\s\\S]*")}$`);
    return !ERROR_MESSAGES.some((key) => shape.test(key));
  });
  assert.deepEqual(missing.map((m) => `${m.file}: ${m.text}`), [], "add a key with {placeholders} to src/lib/i18n/errors/source.ts");
});

void test("translations keep exactly the placeholders of their key", () => {
  const catalogs: [string, Partial<ErrorCatalog>][] = [["en-US", enUS], ["es", es], ["pt-BR", ptBR], ["fr", fr], ["de", de], ["ja", ja], ["nl", nl], ["nb", nb], ["zh-CN", zhCN], ["zh-TW", zhTW]];
  const mismatched = catalogs.flatMap(([locale, catalog]) =>
    Object.entries(catalog)
      .filter(([key, translation]) => placeholders(key) !== placeholders(translation))
      .map(([key, translation]) => `${locale}: ${key} => ${translation}`));
  assert.deepEqual(mismatched, []);
});

void test("translateErrorMessage translates exact and parameterised messages", () => {
  assert.equal(translateErrorMessage("board not found", "es"), "No se encontró el tablero.");
  assert.equal(translateErrorMessage("not found", "fr"), "Introuvable.");
  assert.equal(translateErrorMessage("organisation not found", "en-US"), "organization not found");
  assert.equal(translateErrorMessage("board not found", "en-US"), "board not found");
  assert.equal(translateErrorMessage("organisation not found", "en-GB"), "organisation not found");

  assert.equal(
    translateErrorMessage("automation action list not found: Doing (QA)", "pt-BR"),
    "Lista da ação de automação não encontrada: Doing (QA)",
  );
  assert.equal(translateErrorMessage("CSV exceeds the 5,000 row limit", "ja"), "CSVが行数の上限（5,000行）を超えています。");
  // The more specific pattern wins over "{field} not found".
  assert.equal(translateErrorMessage("card anchor not found", "de"), "card-Anker nicht gefunden.");
  assert.equal(translateErrorMessage("afterGroupId not found", "de"), "afterGroupId nicht gefunden.");
  // A wrapped message is translated too.
  assert.equal(translateErrorMessage("cards[2]: card not found", "es"), "cards[2]: No se encontró la tarjeta.");
  // French puts a non-breaking space before the colon.
  assert.equal(translateErrorMessage("could not parse CSV: bad quote", "fr"), "Impossible d'analyser le CSV\u00a0: bad quote");

  assert.equal(translateErrorMessage("something nobody catalogued", "ja"), "something nobody catalogued");
});
