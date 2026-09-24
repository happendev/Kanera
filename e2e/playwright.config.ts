import { defineConfig } from "@playwright/test";
import path from "node:path";
import ports from "./ports.json";
import { contextDefaults, webOrigin } from "./support/env";

const artifactDir = process.env.KANERA_E2E_ARTIFACT_DIR ?? path.join(__dirname, "artifacts", "manual");

// Every service shares the isolated database/Valkey exported by scripts/test-e2e.sh; the ports are
// E2E-only so a local dev stack (3000-3003, 4200) can keep running alongside a test run.
const serviceEnv = {
  API_PORT: String(ports.api),
  PUBLIC_API_PORT: String(ports.publicApi),
  WORKER_PORT: String(ports.worker),
  WEB_ORIGIN: webOrigin,
};

function apiProcess(script: string, logName: string, port: number) {
  return {
    command: `pnpm --dir ../apps/api ${script} > "$KANERA_E2E_ARTIFACT_DIR/${logName}.log" 2>&1`,
    url: `http://localhost:${port}/health`,
    env: serviceEnv,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe" as const,
    stderr: "pipe" as const,
  };
}

export default defineConfig({
  testDir: __dirname,
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: path.join(artifactDir, "test-results"),
  reporter: [
    ["line"],
    ["json", { outputFile: path.join(artifactDir, "results.json") }],
    ["html", { outputFolder: path.join(artifactDir, "report"), open: "never" }],
  ],
  use: {
    ...contextDefaults,
    browserName: "chromium",
    headless: true,
    actionTimeout: 15_000,
    trace: "on",
    screenshot: "on",
  },
  webServer: [
    apiProcess("start", "api", ports.api),
    apiProcess("start:public-api", "public-api", ports.publicApi),
    apiProcess("start:worker", "worker", ports.worker),
    {
      command: `pnpm --dir ../apps/web exec ng serve --configuration e2e --port ${ports.web} --proxy-config ../../e2e/web-proxy.config.mjs > "$KANERA_E2E_ARTIFACT_DIR/web.log" 2>&1`,
      url: `${webOrigin}/login`,
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
