import { defineConfig } from "@playwright/test";

// The regular E2E build intentionally disables analytics. This isolated production-configured
// browser suite intercepts every API/analytics request; it never connects to production.
export default defineConfig({
  testDir: "./analytics",
  testMatch: "*.browser.ts",
  outputDir: "./artifacts/analytics",
  timeout: 45_000,
  workers: 1,
  use: {
    baseURL: "http://board.kanera.test:4223",
    serviceWorkers: "block",
    trace: "on",
    screenshot: "on",
    launchOptions: { args: ["--host-resolver-rules=MAP board.kanera.test 127.0.0.1", "--disable-blink-features=AutomationControlled"] },
  },
  webServer: {
    command: "pnpm --filter @kanera/web exec ng serve --configuration push-https --host 0.0.0.0 --port 4223 --allowed-hosts --watch=false --hmr=false --live-reload=false",
    url: "http://127.0.0.1:4223",
    timeout: 180_000,
    reuseExistingServer: false,
  },
});
