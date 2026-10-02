import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../args.js";
import { openBrowserIfEnabled, webUrlForApi } from "./auth.js";

void test("--no-browser suppresses the API key page launch", () => {
  const { flags } = parseArgs(["auth", "login", "--no-browser"]);
  const launched: string[] = [];

  openBrowserIfEnabled(flags, "https://board.kanera.app/settings/api-keys", (url) => launched.push(url));

  assert.deepEqual(launched, []);
});

void test("auth login launches the API key page by default", () => {
  const { flags } = parseArgs(["auth", "login"]);
  const launched: string[] = [];

  openBrowserIfEnabled(flags, "https://board.kanera.app/settings/api-keys", (url) => launched.push(url));

  assert.deepEqual(launched, ["https://board.kanera.app/settings/api-keys"]);
});

void test("hosted API key link points at the hosted web app", () => {
  assert.equal(webUrlForApi("https://api.kanera.app"), "https://board.kanera.app");
  assert.equal(webUrlForApi("https://api.kanera.app/"), "https://board.kanera.app");
});

void test("self-hosted API origins get no guessed web app link", () => {
  // Opening a guessed or hosted URL here would have the user mint a key on the wrong server.
  assert.equal(webUrlForApi("https://api.your-kanera.example"), null);
  assert.equal(webUrlForApi("http://localhost:3001"), null);
});
