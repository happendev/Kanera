import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { configDir } from "./config.js";
import type { OutputMode } from "./output.js";

const PACKAGE = "@kanera/cli";
const REGISTRY_LATEST = `https://registry.npmjs.org/${PACKAGE}/latest`;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The registry lookup runs alongside the command; this caps how long it can delay the exit. */
const LOOKUP_TIMEOUT_MS = 1500;

interface UpdateState {
  /** When the registry was last asked, successfully or not, so an offline machine is not re-probed every run. */
  checkedAt?: number;
  latest?: string;
  promptedAt?: number;
}

export interface UpdateCheckDeps {
  currentVersion: string;
  mode: OutputMode;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** A person at a terminal who can answer. Agents and scripts run without TTYs and are never asked. */
  interactive?: () => boolean;
  /** How the executable was launched; an `npx` run is not the global install a prompt would update. */
  entrypoint?: string;
  fetchLatest?: (signal: AbortSignal) => Promise<string | undefined>;
  ask?: (question: string) => Promise<string>;
  install?: (version: string) => Promise<boolean>;
  write?: (text: string) => void;
  statePath?: string;
}

export interface UpdateCheck {
  /** Offer the update once the command has finished, so its output is never interleaved with the question. */
  offer(): Promise<void>;
}

/**
 * Start a background lookup of the newest published CLI and return a handle that can offer to
 * install it. The CLI is mostly driven by AI agents, so the offer is restricted to a human at an
 * interactive terminal in human output mode: a y/n question on a non-TTY stdin would hang an agent or
 * a CI job, and anything written in --json/--quiet mode would corrupt a parsed result. The registry
 * is asked at most once a day and the question asked at most once a day, so declining is respected.
 */
export function startUpdateCheck(deps: UpdateCheckDeps): UpdateCheck | undefined {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const interactive = deps.interactive ?? (() => Boolean(process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY));
  const entrypoint = deps.entrypoint ?? process.argv[1] ?? "";
  if (deps.mode !== "human") return undefined;
  if (env.KANERA_NO_UPDATE_CHECK || env.CI) return undefined;
  if (!parseVersion(deps.currentVersion) || deps.currentVersion.startsWith("0.0.0")) return undefined;
  // npx resolves its own copy per invocation; installing globally would not change what ran here.
  if (/[\\/]_npx[\\/]/u.test(entrypoint)) return undefined;
  if (!interactive()) return undefined;

  const statePath = deps.statePath ?? join(configDir(), "update-check.json");
  const state = readState(statePath);
  const fetchLatest = deps.fetchLatest ?? fetchLatestFromRegistry;

  let lookup: Promise<string | undefined>;
  if (state.checkedAt !== undefined && now() - state.checkedAt < DAY_MS) {
    lookup = Promise.resolve(state.latest);
  } else {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
    timer.unref();
    lookup = fetchLatest(controller.signal)
      .catch(() => undefined)
      .then((latest) => {
        clearTimeout(timer);
        state.checkedAt = now();
        if (latest) state.latest = latest;
        writeState(statePath, state);
        return latest ?? state.latest;
      });
  }

  return {
    async offer() {
      const latest = await lookup;
      if (!latest || !isNewer(latest, deps.currentVersion)) return;
      if (state.promptedAt !== undefined && now() - state.promptedAt < DAY_MS) return;
      state.promptedAt = now();
      writeState(statePath, state);

      const write = deps.write ?? ((text: string) => process.stderr.write(text));
      const ask = deps.ask ?? askOnTerminal;
      const answer = await ask(`\nA new Kanera CLI is available: ${deps.currentVersion} → ${latest}\nUpdate now? [y/N] `);
      if (!/^y(es)?$/iu.test(answer.trim())) {
        write(`Skipped. Update later with: npm install --global ${PACKAGE}@latest\n`);
        return;
      }
      const install = deps.install ?? installWithNpm;
      if (await install(latest)) {
        write(`Updated the Kanera CLI to ${latest}.\n`);
      } else {
        write(`The update did not complete. Run it yourself: npm install --global ${PACKAGE}@latest\n`);
      }
    },
  };
}

/** Stable releases only: a prerelease on `latest` is a publishing mistake, not an upgrade to push. */
function parseVersion(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i]! > b[i]!;
  }
  return false;
}

async function fetchLatestFromRegistry(signal: AbortSignal): Promise<string | undefined> {
  const response = await fetch(REGISTRY_LATEST, { signal, headers: { accept: "application/json" } });
  if (!response.ok) return undefined;
  const body = await response.json() as { version?: unknown };
  return typeof body.version === "string" ? body.version : undefined;
}

async function askOnTerminal(question: string): Promise<string> {
  const input = createInterface({ input: process.stdin, output: process.stderr });
  return await new Promise<string>((resolve) => {
    // Ctrl+C or Ctrl+D at the question is a "no", not a crash after the command already succeeded.
    input.on("close", () => resolve(""));
    input.question(question, (answer) => {
      resolve(answer);
      input.close();
    });
  });
}

async function installWithNpm(version: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    // npm is a .cmd shim on Windows, which only a shell can launch.
    const child = spawn("npm", ["install", "--global", `${PACKAGE}@${version}`], {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

function readState(path: string): UpdateState {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as UpdateState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Best effort: a read-only home directory must never turn a successful command into a failure. */
function writeState(path: string, state: UpdateState): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  } catch {
    // Ignored deliberately; the next run simply checks again.
  }
}
