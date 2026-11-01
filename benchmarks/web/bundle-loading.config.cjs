const { defineConfig } = require("@playwright/test");
const path = require("node:path");
const baseURL = process.env.BUNDLE_BASE_URL ?? "http://localhost:4200";
if (!["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname)) {
  throw new Error("Bundle verification only runs against a local production build");
}
module.exports = defineConfig({
  testDir: __dirname,
  testMatch: "bundle-loading.spec.cjs",
  workers: 1,
  timeout: 60_000,
  outputDir: path.resolve(__dirname, "../../e2e/artifacts/bundle-loading"),
  reporter: "line",
  use: { baseURL, locale: "en-GB", viewport: { width: 1440, height: 1000 }, trace: "on", screenshot: "on" },
});
