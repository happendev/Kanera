import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../args.js";
import { run } from "../cli.js";
import { EXIT } from "../errors.js";
import { cliClientName } from "../oauth.js";
import { agentName, openBrowserIfEnabled, webUrlForApi } from "./auth.js";

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

/**
 * The OAuth client name is the only agent identity Kanera records for CLI work. Failure modes:
 * the agent's name is dropped (work reads "via Kanera CLI"), the machine is dropped (two laptops'
 * sign-ins become indistinguishable in Settings), or a crafted name injects extra lines into the
 * consent screen and activity feed.
 */
void test("an agent name from --agent or KANERA_AGENT_NAME labels the sign-in", () => {
  assert.equal(agentName(parseArgs(["auth", "login", "--agent", "  Claude   Code "]), {}), "Claude Code");
  assert.equal(agentName(parseArgs(["auth", "login"]), { KANERA_AGENT_NAME: "Codex" }), "Codex");
  // The explicit flag wins over an ambient environment variable.
  assert.equal(agentName(parseArgs(["auth", "login", "--agent", "Cursor"]), { KANERA_AGENT_NAME: "Codex" }), "Cursor");
  assert.equal(agentName(parseArgs(["auth", "login"]), {}), undefined);
  assert.equal(agentName(parseArgs(["auth", "login"]), { KANERA_AGENT_NAME: "  " }), undefined);

  assert.equal(cliClientName("Claude Code", "dev-laptop"), "Claude Code (Kanera CLI on dev-laptop)");
  assert.equal(cliClientName(undefined, "dev-laptop"), "Kanera CLI (dev-laptop)");
});

void test("an agent name must be a short single line", () => {
  assert.throws(() => agentName(parseArgs(["auth", "login", "--agent"]), {}), /needs a name/u);
  assert.throws(() => agentName(parseArgs(["auth", "login", "--agent", ""]), {}), /needs a name/u);
  assert.throws(() => agentName(parseArgs(["auth", "login"]), { KANERA_AGENT_NAME: "Claude\u0007" }), /control characters/u);
  assert.throws(() => agentName(parseArgs(["auth", "login", "--agent", "x".repeat(65)]), {}), /64 characters/u);
});

void test("--agent with an API key is refused, because a personal key is recorded as its owner", async () => {
  const err: string[] = [];
  const code = await run(["auth", "login", "--with-api-key", "--agent", "Claude Code"], {
    stdout: () => {},
    stderr: (text) => err.push(text),
  });
  assert.equal(code, EXIT.usage);
  assert.match(err.join(""), /--agent applies only to a browser sign-in/u);
});
