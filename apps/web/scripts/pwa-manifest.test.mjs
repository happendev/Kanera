import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";

const root = resolve(import.meta.dirname, "../public");
const standard = JSON.parse(readFileSync(resolve(root, "assets/favicon/manifest.json"), "utf8"));
const samsung = JSON.parse(readFileSync(resolve(root, "assets/favicon/manifest-samsung.json"), "utf8"));
const index = readFileSync(resolve(import.meta.dirname, "../src/index.html"), "utf8");

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
    ["Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 SamsungBrowser/25.0", "manifest-samsung.json"],
    ["Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120", "manifest.json"],
  ]) {
    const dom = new JSDOM(index, {
      url: "https://board.kanera.app/",
      runScripts: "dangerously",
      beforeParse(window) {
        Object.defineProperty(window.navigator, "userAgent", { value: userAgent });
      },
    });
    assert.equal(dom.window.document.querySelector('link[rel="manifest"]')?.getAttribute("href"), `/assets/favicon/${expected}`);
    dom.window.close();
  }
});
