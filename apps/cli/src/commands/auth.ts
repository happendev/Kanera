import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { DEFAULT_PUBLIC_API_URL, DEFAULT_WEB_URL, readConfig, removeProfile, resolveCredential, saveProfile, validateApiUrl } from "../config.js";
import { CliError, EXIT, usageError } from "../errors.js";
import type { CommandContext, CommandResult } from "../context.js";
import { openToolSession } from "../tools.js";

interface SessionSummary {
  userId?: string;
  organisationName?: string;
  credentialKind?: string;
  workspaceId?: string | null;
  scope?: string | null;
  webUrl?: string;
}

/**
 * The public API session names the organisation and the user id but no display name or email, so
 * the profile label is built from what it actually returns rather than fields that are always
 * undefined.
 */
function identityLabel(session: SessionSummary): string {
  return session.organisationName
    ? `${session.organisationName} (${session.userId ?? "unknown user"})`
    : session.userId ?? "unknown user";
}

/**
 * The web app that serves the "create a key" page for an API origin, or null when it cannot be known.
 * Only hosted Kanera has a fixed pairing (api.kanera.app -> board.kanera.app). A self-hosted public API
 * lives on whatever domain the operator chose, and the session endpoint that reports `webUrl` needs the
 * key we are about to ask for, so guessing would send the user to the wrong server to mint a key.
 */
export function webUrlForApi(apiUrl: string): string | null {
  try {
    if (new URL(apiUrl).origin === DEFAULT_PUBLIC_API_URL) return DEFAULT_WEB_URL;
  } catch {
    // An unparseable origin is rejected by validateApiUrl before this is reached.
  }
  return null;
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    // Detached and fully ignored: a browser that outlives the CLI must not hold its stdio open or
    // print into the command's output.
    spawn(command, [url], { detached: true, stdio: "ignore", shell: process.platform === "win32" }).unref();
  } catch {
    // A headless machine has no browser; the printed URL is the fallback and is always shown.
  }
}

/** Honour the parser's normalized `--no-browser` representation before launching anything. */
export function openBrowserIfEnabled(
  flags: CommandContext["flags"],
  url: string,
  launch: (target: string) => void = openBrowser,
): void {
  if (flags.browser !== false) launch(url);
}

async function promptSecret(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  const input = createInterface({ input: process.stdin, terminal: true });
  return await new Promise<string>((resolve) => {
    // Suppressing the echo keeps the pasted key out of the terminal scrollback, where it would
    // otherwise sit in plain text alongside the shell history.
    const muted = input as unknown as { _writeToOutput?: (chunk: string) => void };
    muted._writeToOutput = () => {};
    input.question("", (answer) => {
      input.close();
      process.stderr.write("\n");
      resolve(answer.trim());
    });
  });
}

async function describeSession(apiKey: string, url: string): Promise<SessionSummary> {
  const session = await openToolSession({ apiKey, publicApiUrl: url });
  try {
    return await session.call("session.get", {}) as SessionSummary;
  } finally {
    await session.close();
  }
}

export async function authCommand(ctx: CommandContext): Promise<CommandResult> {
  const action = ctx.positionals[1] ?? "status";
  switch (action) {
    case "login": return await login(ctx);
    case "status": return await status(ctx);
    case "logout": return logout(ctx);
    case "token": return token(ctx);
    case "list": return listProfiles();
    default: throw usageError(`unknown auth command "${action}"`, "Try: login, status, logout, token, list");
  }
}

async function login(ctx: CommandContext): Promise<CommandResult> {
  const profile = ctx.profileFlag ?? process.env.KANERA_PROFILE ?? "default";
  const url = validateApiUrl(ctx.urlFlag ?? process.env.KANERA_PUBLIC_API_URL ?? "https://api.kanera.app");
  let apiKey = ctx.apiKeyFlag;

  if (!apiKey) {
    if (!process.stdin.isTTY) {
      throw usageError("no API key supplied and stdin is not a terminal", "Pass --api-key, or set KANERA_API_KEY.");
    }
    const webUrl = webUrlForApi(url);
    const keysUrl = webUrl ? `${webUrl}/settings/api-keys` : null;
    process.stderr.write(
      (keysUrl
        ? `Create a personal API key at:\n  ${keysUrl}\n\n`
        : "Create a personal API key in your Kanera web app under Settings -> API Keys.\n\n")
      + "Choose Read-only if this credential is for an AI agent that should not change anything.\n\n",
    );
    if (keysUrl) openBrowserIfEnabled(ctx.flags, keysUrl);
    apiKey = await promptSecret("Paste your Kanera API key: ");
  }
  if (!apiKey.startsWith("kanera_")) {
    throw new CliError("that does not look like a Kanera API key", EXIT.unauthenticated, "Keys begin with kanera_.");
  }

  // Validate before storing, so a mistyped key fails here rather than on the user's next command.
  const session = await describeSession(apiKey, url);
  saveProfile(profile, {
    apiKey,
    url,
    label: identityLabel(session),
    scope: session.scope ?? undefined,
  }, true);

  return {
    summary: `Signed in as ${identityLabel(session)}`
      + ` (profile "${profile}", scope ${session.scope ?? "unknown"}).`,
    data: { profile, url, scope: session.scope ?? null, session },
  };
}

async function status(ctx: CommandContext): Promise<CommandResult> {
  const credential = resolveCredential({ apiKeyFlag: ctx.apiKeyFlag, urlFlag: ctx.urlFlag, profileFlag: ctx.profileFlag });
  const session = await describeSession(credential.apiKey, credential.url);
  return {
    summary: `${identityLabel(session)} · scope ${session.scope ?? "unknown"}`
      + ` · profile "${credential.profile}" (${credential.source})`,
    data: { profile: credential.profile, source: credential.source, url: credential.url, session },
  };
}

function logout(ctx: CommandContext): CommandResult {
  const profile = ctx.profileFlag ?? process.env.KANERA_PROFILE ?? readConfig().defaultProfile;
  const removed = removeProfile(profile);
  return {
    summary: removed ? `Removed profile "${profile}".` : `No stored profile "${profile}".`,
    data: { profile, removed },
  };
}

function token(ctx: CommandContext): CommandResult {
  const credential = resolveCredential({ apiKeyFlag: ctx.apiKeyFlag, urlFlag: ctx.urlFlag, profileFlag: ctx.profileFlag });
  // Printed bare so `KANERA_API_KEY=$(kanera auth token)` works; the summary would corrupt that.
  return { data: credential.apiKey, raw: credential.apiKey };
}

function listProfiles(): CommandResult {
  const config = readConfig();
  const rows = Object.entries(config.profiles).map(([name, profile]) => ({
    profile: name,
    default: name === config.defaultProfile,
    url: profile.url ?? "",
    label: profile.label ?? "",
    scope: profile.scope ?? "",
  }));
  return { summary: rows.length === 0 ? "No stored profiles." : undefined, data: { profiles: rows } };
}
