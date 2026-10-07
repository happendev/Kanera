import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CliError, EXIT } from "./errors.js";

export const DEFAULT_PUBLIC_API_URL = "https://api.kanera.app";
export const DEFAULT_WEB_URL = "https://board.kanera.app";
export const DEFAULT_MCP_URL = "https://mcp.kanera.app/mcp";

/**
 * An OAuth sign-in from `kanera auth login`. Its tokens are issued for the MCP endpoint (the
 * protected resource), never for `/api/v1`, so a profile holding one runs tools against `mcpUrl`
 * rather than in-process against the public API.
 */
export interface OAuthProfile {
  mcpUrl: string;
  /** The `resource` the tokens are bound to, as the MCP server advertises it. */
  resource: string;
  issuer: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  clientId: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
}

export interface Profile {
  /** Set for API-key profiles. Exactly one of `apiKey` and `oauth` is present. */
  apiKey?: string;
  oauth?: OAuthProfile;
  url?: string;
  /** Cached from `GET /api/v1/session` at login, for `auth status` without a round trip. */
  label?: string;
  /** The agent named at OAuth login; Kanera labels this sign-in's work "via <agent> (Kanera CLI …)". */
  agent?: string;
  scope?: string;
}

export interface CliConfig {
  version: 1;
  defaultProfile: string;
  profiles: Record<string, Profile>;
}

/** Non-secret, committable per-repo defaults. Credentials are never read from the repo. */
export interface RepoConfig {
  profile?: string;
}

const EMPTY: CliConfig = { version: 1, defaultProfile: "default", profiles: {} };

export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg && xdg.trim() !== "" ? xdg : join(homedir(), ".config"), "kanera");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function readConfig(): CliConfig {
  const path = configPath();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CliConfig>;
    return {
      version: 1,
      defaultProfile: parsed.defaultProfile ?? "default",
      profiles: parsed.profiles ?? {},
    };
  } catch (error) {
    // Logout can remove the file while an unlocked reader is resolving a credential.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY, profiles: {} };
    throw new CliError(`${path} is not valid JSON`, EXIT.failed, "Delete it and run `kanera auth login` again.");
  }
}

export function writeConfig(config: CliConfig): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Readers do not take the mutation lock. Publish a complete owner-only file in one rename so
  // parallel commands never see truncated JSON, and flush rotated tokens before using them.
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** All read-modify-write operations, including refresh, login and logout, share this lock. */
export async function withConfigLock<T>(work: () => Promise<T> | T): Promise<T> {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  // Keep the existing filename so a CLI already running during an upgrade shares the lock.
  const path = join(configDir(), "refresh.lock");
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      closeSync(openSync(path, "wx", 0o600));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        // Network operations under this lock have a 15-second timeout; recover abandoned locks.
        if (Date.now() - statSync(path).mtimeMs > 30_000) {
          rmSync(path, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) throw new CliError("timed out waiting for another kanera process to update credentials", EXIT.failed);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return await work();
  } finally {
    rmSync(path, { force: true });
  }
}

export function readRepoConfig(cwd = process.cwd()): RepoConfig {
  // Walk up so the CLI works from a subdirectory of the repo, the same way git config does.
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, ".kanera", "config.json");
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as Record<string, unknown>;
        return {
          profile: typeof parsed.profile === "string" ? parsed.profile : undefined,
        };
      } catch {
        return {};
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return {};
    dir = parent;
  }
}

interface CredentialBase {
  url: string;
  profile: string;
  /** Where the credential came from, so `auth status` and `doctor` can explain what is in effect. */
  source: "flag" | "env" | "profile";
}

export type Credential =
  | (CredentialBase & { kind: "apiKey"; apiKey: string })
  | (CredentialBase & { kind: "oauth"; oauth: OAuthProfile });

export interface ResolveOptions {
  apiKeyFlag?: string;
  urlFlag?: string;
  profileFlag?: string;
  cwd?: string;
}

/**
 * Validate the origin before a bearer credential can be sent to it. Repository-owned files never
 * participate in endpoint selection; an endpoint is trusted only when the user supplied it
 * explicitly or it was saved alongside the credential during login.
 */
export function validateApiUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError(`invalid Kanera API URL "${value}"`, EXIT.usage, "Pass an absolute https:// URL.");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new CliError(
      `refusing insecure Kanera API URL "${value}"`,
      EXIT.usage,
      "Use HTTPS. Plain HTTP is allowed only for localhost development.",
    );
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "" && url.pathname !== "/")) {
    throw new CliError(`Kanera API URL must be an origin, not a path: "${value}"`, EXIT.usage);
  }
  return url.origin;
}

/**
 * Validate a URL that a credential or token will be sent to, where a path is legitimate (the MCP
 * endpoint, OAuth endpoints). The same HTTPS-except-loopback rule as API origins applies.
 */
export function validateEndpointUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError(`invalid ${label} "${value}"`, EXIT.usage, "Pass an absolute https:// URL.");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new CliError(`refusing insecure ${label} "${value}"`, EXIT.usage, "Use HTTPS. Plain HTTP is allowed only for localhost development.");
  }
  if (url.username || url.password || url.hash) throw new CliError(`invalid ${label} "${value}"`, EXIT.usage);
  return url.toString();
}

/**
 * Resolve the credential for this invocation. Precedence is explicit flag, then environment, then
 * a stored profile: an agent running in CI sets `KANERA_API_KEY` and needs no config file at all,
 * while a human keeps named profiles.
 */
export function resolveCredential(options: ResolveOptions = {}): Credential {
  const repo = readRepoConfig(options.cwd);
  const config = readConfig();
  const profileName = options.profileFlag ?? process.env.KANERA_PROFILE ?? repo.profile ?? config.defaultProfile;
  const stored = config.profiles[profileName];
  // Do not read an API origin from .kanera/config.json. In agent and CI environments that file is
  // controlled by the checked-out repository and must not be able to redirect KANERA_API_KEY.
  const url = validateApiUrl(options.urlFlag
    ?? process.env.KANERA_PUBLIC_API_URL
    ?? stored?.url
    ?? DEFAULT_PUBLIC_API_URL);

  if (options.apiKeyFlag) return { kind: "apiKey", apiKey: options.apiKeyFlag, url, profile: profileName, source: "flag" };
  const fromEnv = process.env.KANERA_API_KEY;
  if (fromEnv && fromEnv.trim() !== "") return { kind: "apiKey", apiKey: fromEnv.trim(), url, profile: profileName, source: "env" };
  // An explicit key always wins over a stored OAuth sign-in, so CI that exports KANERA_API_KEY is
  // never silently routed through a developer's personal session on the same machine.
  if (stored?.oauth) return { kind: "oauth", oauth: stored.oauth, url, profile: profileName, source: "profile" };
  if (stored?.apiKey) return { kind: "apiKey", apiKey: stored.apiKey, url, profile: profileName, source: "profile" };

  throw new CliError(
    `no Kanera credential for profile "${profileName}"`,
    EXIT.unauthenticated,
    "Run `kanera auth login`, or set KANERA_API_KEY.",
  );
}

/** Return the replaced profile under the lock so login revokes the connection it actually replaced. */
export async function saveProfile(name: string, profile: Profile, makeDefault: boolean): Promise<Profile | undefined> {
  return await withConfigLock(() => {
    const config = readConfig();
    const previous = config.profiles[name];
    config.profiles[name] = profile;
    if (makeDefault || Object.keys(config.profiles).length === 1) config.defaultProfile = name;
    writeConfig(config);
    return previous;
  });
}

export async function removeProfile(name: string, beforeRemove?: (profile: Profile) => Promise<void>): Promise<boolean> {
  return await withConfigLock(async () => {
    const config = readConfig();
    if (!(name in config.profiles)) return false;
    // Revoke the latest refresh token while rotation is excluded, before forgetting the sign-in.
    await beforeRemove?.(config.profiles[name]!);
    delete config.profiles[name];
    if (config.defaultProfile === name) config.defaultProfile = Object.keys(config.profiles)[0] ?? "default";
    if (Object.keys(config.profiles).length === 0) rmSync(configPath(), { force: true });
    else writeConfig(config);
    return true;
  });
}
