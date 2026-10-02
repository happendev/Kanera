import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { boolFlag, stringFlag } from "../args.js";
import {
  DEFAULT_MCP_URL, DEFAULT_PUBLIC_API_URL, DEFAULT_WEB_URL, readConfig, removeProfile, resolveCredential, saveProfile, validateApiUrl,
  type OAuthProfile,
} from "../config.js";
import { discover, pollForTokens, registerClient, revoke, sessionOptionsFor, startDeviceAuthorization } from "../oauth.js";
import { CliError, EXIT, usageError } from "../errors.js";
import type { CommandContext, CommandResult } from "../context.js";
import { openToolSession, type ToolSessionOptions } from "../tools.js";

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

async function describeSession(options: ToolSessionOptions): Promise<SessionSummary> {
  const session = await openToolSession(options);
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
    case "logout": return await logout(ctx);
    case "token": return token(ctx);
    case "list": return listProfiles();
    default: throw usageError(`unknown auth command "${action}"`, "Try: login, status, logout, token, list");
  }
}

async function login(ctx: CommandContext): Promise<CommandResult> {
  const profile = ctx.profileFlag ?? process.env.KANERA_PROFILE ?? "default";
  // A key on the command line, or an explicit request for one, keeps the API-key flow: CI and
  // unattended agents have nobody to approve a browser sign-in, and read-only keys are the
  // server-enforced way to keep an agent from writing.
  if (ctx.apiKeyFlag || boolFlag(ctx.flags, "with-api-key")) return await loginWithApiKey(ctx, profile);
  return await loginWithOAuth(ctx, profile);
}

/** Which MCP endpoint to sign in to. Its metadata names the authorization server. */
function mcpUrlForLogin(ctx: CommandContext): string {
  const explicit = stringFlag(ctx.flags, "mcp-url") ?? process.env.KANERA_MCP_URL;
  if (explicit) return explicit;
  const apiUrl = ctx.urlFlag ?? process.env.KANERA_PUBLIC_API_URL;
  if (apiUrl && validateApiUrl(apiUrl) !== DEFAULT_PUBLIC_API_URL) {
    // A self-hosted MCP address is chosen by its operator and cannot be derived from the API origin.
    throw usageError(
      "browser sign-in to a self-hosted Kanera needs its MCP address",
      "Pass --mcp-url https://your-kanera.example/mcp, or sign in with --with-api-key.",
    );
  }
  return DEFAULT_MCP_URL;
}

async function loginWithOAuth(ctx: CommandContext, profile: string): Promise<CommandResult> {
  const server = await discover(mcpUrlForLogin(ctx));
  const clientId = await registerClient(server);
  const device = await startDeviceAuthorization(server, clientId);
  const openUrl = device.verificationUriComplete ?? device.verificationUri;
  process.stderr.write(
    `To sign in, open:\n  ${openUrl}\n\n`
    + `and check that it shows this code:\n  ${device.userCode}\n\n`
    + "Waiting for approval in the browser...\n",
  );
  openBrowserIfEnabled(ctx.flags, openUrl);
  const oauth = await pollForTokens(server, clientId, device);

  // Not saved yet, so the session uses the fresh token directly instead of reading the profile.
  const session = await describeSession({ mcpUrl: oauth.mcpUrl, accessToken: async () => oauth.accessToken });
  const previous = (await saveProfile(profile, { oauth, label: identityLabel(session), scope: session.scope ?? undefined }, true))?.oauth;
  // Signing in again replaces the old sign-in; end it on the server so it does not linger in
  // Settings -> AI agents with a refresh token nobody holds.
  if (previous) await revoke(previous);

  return {
    summary: `Signed in as ${identityLabel(session)} (profile "${profile}", OAuth).`,
    data: { profile, kind: "oauth", mcpUrl: oauth.mcpUrl, scope: session.scope ?? null, session },
  };
}

async function loginWithApiKey(ctx: CommandContext, profile: string): Promise<CommandResult> {
  const url = validateApiUrl(ctx.urlFlag ?? process.env.KANERA_PUBLIC_API_URL ?? DEFAULT_PUBLIC_API_URL);
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
  const session = await describeSession({ apiKey, publicApiUrl: url });
  const previous = (await saveProfile(profile, {
    apiKey,
    url,
    label: identityLabel(session),
    scope: session.scope ?? undefined,
  }, true))?.oauth;
  if (previous) await revoke(previous);

  return {
    summary: `Signed in as ${identityLabel(session)}`
      + ` (profile "${profile}", scope ${session.scope ?? "unknown"}).`,
    data: { profile, kind: "apiKey", url, scope: session.scope ?? null, session },
  };
}

async function status(ctx: CommandContext): Promise<CommandResult> {
  const credential = resolveCredential({ apiKeyFlag: ctx.apiKeyFlag, urlFlag: ctx.urlFlag, profileFlag: ctx.profileFlag });
  const session = await describeSession(sessionOptionsFor(credential));
  const endpoint = credential.kind === "oauth" ? credential.oauth.mcpUrl : credential.url;
  return {
    summary: `${identityLabel(session)} · scope ${session.scope ?? "unknown"}`
      + ` · profile "${credential.profile}" (${credential.kind === "oauth" ? "OAuth" : "API key"}, ${credential.source})`,
    data: { profile: credential.profile, kind: credential.kind, source: credential.source, url: endpoint, session },
  };
}

async function logout(ctx: CommandContext): Promise<CommandResult> {
  const profile = ctx.profileFlag ?? process.env.KANERA_PROFILE ?? readConfig().defaultProfile;
  let oauth: OAuthProfile | undefined;
  let revoked = false;
  const removed = await removeProfile(profile, async (stored) => {
    oauth = stored.oauth;
    if (oauth) revoked = await revoke(oauth);
  });
  const note = oauth && !revoked ? " Kanera could not be reached to end the sign-in; revoke it under Settings -> AI agents." : "";
  return {
    summary: (removed ? `Removed profile "${profile}".` : `No stored profile "${profile}".`) + note,
    data: { profile, removed, revoked },
  };
}

function token(ctx: CommandContext): CommandResult {
  const credential = resolveCredential({ apiKeyFlag: ctx.apiKeyFlag, urlFlag: ctx.urlFlag, profileFlag: ctx.profileFlag });
  if (credential.kind === "oauth") {
    // The OAuth access token is short-lived and only accepted by the MCP endpoint. Printing it where
    // a caller expects an API key would produce a credential that fails on /api/v1 within minutes.
    throw new CliError(
      `profile "${credential.profile}" is signed in with OAuth, which has no API key to print`,
      EXIT.usage,
      "Create an API key for KANERA_API_KEY and run `kanera auth login --with-api-key`, or point MCP clients at `kanera mcp`.",
    );
  }
  // Printed bare so `KANERA_API_KEY=$(kanera auth token)` works; the summary would corrupt that.
  return { data: credential.apiKey, raw: credential.apiKey };
}

function listProfiles(): CommandResult {
  const config = readConfig();
  const rows = Object.entries(config.profiles).map(([name, profile]) => ({
    profile: name,
    default: name === config.defaultProfile,
    kind: profile.oauth ? "oauth" : "apiKey",
    url: profile.oauth?.mcpUrl ?? profile.url ?? "",
    label: profile.label ?? "",
    scope: profile.scope ?? "",
  }));
  return { summary: rows.length === 0 ? "No stored profiles." : undefined, data: { profiles: rows } };
}
