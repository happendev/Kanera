import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isNewer, startUpdateCheck, type UpdateCheckDeps } from "./update.js";

/**
 * Failure modes this guards:
 * - an agent or CI run (no TTY, --json, --quiet, CI=1) is asked a question and hangs, or gets prose
 *   mixed into a parsed result;
 * - the registry is hit on every invocation instead of once a day;
 * - declining is ignored and the question returns on the very next command;
 * - "no" or a failed install still runs or reports an install;
 * - a prerelease or older registry version is offered as an upgrade.
 */
function harness(overrides: Partial<UpdateCheckDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kanera-update-"));
  const calls = { fetch: 0, ask: 0, install: [] as string[], written: [] as string[] };
  let clock = 1_000_000;
  const deps: UpdateCheckDeps = {
    currentVersion: "1.7.0",
    mode: "human",
    env: {},
    now: () => clock,
    interactive: () => true,
    entrypoint: "/usr/local/bin/kanera",
    fetchLatest: () => { calls.fetch += 1; return Promise.resolve("1.8.0"); },
    ask: () => { calls.ask += 1; return Promise.resolve("y"); },
    install: (version) => { calls.install.push(version); return Promise.resolve(true); },
    write: (text) => { calls.written.push(text); },
    statePath: join(dir, "update-check.json"),
    ...overrides,
  };
  return {
    deps,
    calls,
    advance: (ms: number) => { clock += ms; },
    state: () => JSON.parse(readFileSync(deps.statePath!, "utf8")) as Record<string, unknown>,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

void test("non-interactive, machine-readable and CI runs are never checked or asked", () => {
  const cases: Partial<UpdateCheckDeps>[] = [
    { interactive: () => false },
    { mode: "json" },
    { mode: "quiet" },
    { env: { CI: "true" } },
    { env: { KANERA_NO_UPDATE_CHECK: "1" } },
    { currentVersion: "0.0.0-dev" },
    { entrypoint: "/home/u/.npm/_npx/abc123/node_modules/@kanera/cli/dist/kanera.mjs" },
  ];
  for (const overrides of cases) {
    const h = harness(overrides);
    try {
      assert.equal(startUpdateCheck(h.deps), undefined, JSON.stringify(overrides));
      assert.equal(h.calls.fetch, 0);
    } finally {
      h.cleanup();
    }
  }
});

void test("yes installs the exact latest version after the command", async () => {
  const h = harness();
  try {
    await startUpdateCheck(h.deps)!.offer();
    assert.equal(h.calls.ask, 1);
    assert.deepEqual(h.calls.install, ["1.8.0"]);
    assert.match(h.calls.written.join(""), /Updated the Kanera CLI to 1\.8\.0/u);
  } finally {
    h.cleanup();
  }
});

void test("no (or an empty answer) does not install, and the question waits a day", async () => {
  for (const answer of ["n", ""]) {
    const h = harness({ ask: () => { h.calls.ask += 1; return Promise.resolve(answer); } });
    try {
      await startUpdateCheck(h.deps)!.offer();
      assert.deepEqual(h.calls.install, []);
      assert.match(h.calls.written.join(""), /npm install --global @kanera\/cli@latest/u);

      h.advance(60_000);
      await startUpdateCheck(h.deps)!.offer();
      assert.equal(h.calls.ask, 1, "asked again within a day");
      assert.equal(h.calls.fetch, 1, "registry re-queried within a day");

      h.advance(24 * 60 * 60 * 1000);
      await startUpdateCheck(h.deps)!.offer();
      assert.equal(h.calls.ask, 2);
      assert.equal(h.calls.fetch, 2);
    } finally {
      h.cleanup();
    }
  }
});

void test("a failed install says so instead of claiming success", async () => {
  const h = harness({ install: () => Promise.resolve(false) });
  try {
    await startUpdateCheck(h.deps)!.offer();
    assert.match(h.calls.written.join(""), /did not complete/u);
    assert.doesNotMatch(h.calls.written.join(""), /Updated/u);
  } finally {
    h.cleanup();
  }
});

void test("an unreachable registry is silent and is not retried on every run", async () => {
  const h = harness({ fetchLatest: () => { h.calls.fetch += 1; return Promise.reject(new Error("offline")); } });
  try {
    await startUpdateCheck(h.deps)!.offer();
    assert.equal(h.calls.ask, 0);
    assert.equal(typeof h.state().checkedAt, "number");
    await startUpdateCheck(h.deps)!.offer();
    assert.equal(h.calls.fetch, 1);
  } finally {
    h.cleanup();
  }
});

void test("only a strictly newer stable release counts as an update", () => {
  assert.equal(isNewer("1.8.0", "1.7.0"), true);
  assert.equal(isNewer("1.7.10", "1.7.9"), true);
  assert.equal(isNewer("2.0.0", "1.99.99"), true);
  assert.equal(isNewer("1.7.0", "1.7.0"), false);
  assert.equal(isNewer("1.6.9", "1.7.0"), false);
  assert.equal(isNewer("1.8.0-beta.1", "1.7.0"), false);
});
