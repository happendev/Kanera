import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { LOCALES } from "../../../packages/shared/src/locales.ts";
import { JSDOM } from "jsdom";

const root = resolve(import.meta.dirname, "../public");
const standard = JSON.parse(readFileSync(resolve(root, "assets/favicon/manifest.json"), "utf8"));
const samsung = JSON.parse(readFileSync(resolve(root, "assets/favicon/manifest-samsung.json"), "utf8"));
const index = readFileSync(resolve(import.meta.dirname, "../src/index.html"), "utf8")
  .replace('<script src="/manifest.js"></script>', () => `<script>${readFileSync(resolve(root, "manifest.js"), "utf8")}</script>`);

test("Samsung manifest keeps the same app identity and assets without the POST share target", () => {
  const { share_target: shareTarget, ...withoutShareTarget } = standard;
  assert.equal(shareTarget.method, "POST");
  assert.deepEqual(samsung, withoutShareTarget);
  assert.equal(standard.id, "/");
  assert.ok(standard.screenshots.some((shot) => shot.form_factor === "narrow"));
  for (const asset of [...standard.icons, ...standard.screenshots]) {
    assert.ok(existsSync(resolve(root, asset.src.slice(1))), `${asset.src} exists`);
  }
});

test("Android Samsung Internet gets the compatible manifest while Chrome keeps share capture", () => {
  for (const [userAgent, expected] of [
    ["Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 SamsungBrowser/25.0", "manifest-samsung.es.json"],
    ["Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120", "manifest.es.json"],
  ]) {
    const dom = new JSDOM(index, {
      url: "https://board.kanera.app/",
      runScripts: "dangerously",
      beforeParse(window) {
        window.localStorage.setItem("kanera-locale", "es");
        Object.defineProperty(window.navigator, "userAgent", { value: userAgent });
      },
    });
    assert.equal(dom.window.document.querySelector('link[rel="manifest"]')?.getAttribute("href"), `/assets/favicon/${expected}`);
    dom.window.close();
  }
});

// Browsers install the static JSON rather than Angular templates. Catch a stale locale asset or
// changed app identity across every variant without depending on an OS install dialog in E2E.
test("every language keeps the same install identity and Samsung compatibility", () => {
  for (const locale of LOCALES) {
    const manifest = JSON.parse(readFileSync(resolve(root, `assets/favicon/manifest.${locale}.json`), "utf8"));
    const compatible = JSON.parse(readFileSync(resolve(root, `assets/favicon/manifest-samsung.${locale}.json`), "utf8"));
    const { share_target: shareTarget, ...rest } = manifest;
    assert.equal(shareTarget.method, "POST");
    assert.deepEqual(compatible, rest);
    assert.equal(manifest.id, standard.id);
    assert.equal(manifest.scope, standard.scope);
    assert.equal(manifest.start_url, standard.start_url);
    assert.equal(manifest.lang, locale);
    if (!locale.startsWith("en")) assert.notEqual(manifest.shortcuts[0].name, standard.shortcuts[0].name);
  }
});

// Browser macrolanguage preferences must choose the same Bokmål asset as the app loader.
test("regional, script and macrolanguage preferences select supported manifests", () => {
  for (const [preference, locale] of [["nl-BE", "nl"], ["nb-NO", "nb"], ["no-NO", "nb"], ["zh", "zh-CN"], ["zh-SG", "zh-CN"], ["zh-HK", "zh-TW"], ["zh-MO", "zh-TW"], ["zh-Hant", "zh-TW"], ["zh-Hans", "zh-CN"], ["zh-Hans-HK", "zh-CN"], ["zh-Hant-CN", "zh-TW"], ["ZH_hant_MO", "zh-TW"]]) {
    const dom = new JSDOM(index, {
      url: "https://board.kanera.app/",
      runScripts: "dangerously",
      beforeParse(window) {
        Object.defineProperty(window.navigator, "languages", { value: [preference] });
      },
    });
    assert.equal(dom.window.document.querySelector('link[rel="manifest"]')?.getAttribute("href"), `/assets/favicon/manifest.${locale}.json`);
    dom.window.close();
  }
});
