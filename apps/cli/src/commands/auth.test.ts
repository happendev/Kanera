import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../args.js";
import { openBrowserIfEnabled } from "./auth.js";

void test("--no-browser suppresses the API key page launch", () => {
  const { flags } = parseArgs(["auth", "login", "--no-browser"]);
  const launched: string[] = [];

  openBrowserIfEnabled(flags, "https://app.kanera.app/settings/api-keys", (url) => launched.push(url));

  assert.deepEqual(launched, []);
});

void test("auth login launches the API key page by default", () => {
  const { flags } = parseArgs(["auth", "login"]);
  const launched: string[] = [];

  openBrowserIfEnabled(flags, "https://app.kanera.app/settings/api-keys", (url) => launched.push(url));

  assert.deepEqual(launched, ["https://app.kanera.app/settings/api-keys"]);
});
