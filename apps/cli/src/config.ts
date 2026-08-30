import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CliError, EXIT } from "./errors.js";

export const DEFAULT_PUBLIC_API_URL = "https://api.kanera.app";
export const DEFAULT_WEB_URL = "https://app.kanera.app";

export interface Profile {
  apiKey: string;
  url?: string;
  /** Cached from `GET /api/v1/session` at login, for `auth status` without a round trip. */
  label?: string;
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
  if (!existsSync(path)) return { ...EMPTY, profiles: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CliConfig>;
    return {
      version: 1,
      defaultProfile: parsed.defaultProfile ?? "default",
      profiles: parsed.profiles ?? {},
    };
  } catch {
    throw new CliError(`${path} is not valid JSON`, EXIT.failed, "Delete it and run `kanera auth login` again.");
  }
}

export function writeConfig(config: CliConfig): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // The file holds long-lived API keys, so it is written owner-only. writeFileSync's mode is
  // ignored when the file already exists, hence the explicit chmod after every write.
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
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

export interface Credential {
  apiKey: string;
  url: string;
  profile: string;
  /** Where the key came from, so `auth status` and `doctor` can explain what is in effect. */
  source: "flag" | "env" | "profile";
}

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

  if (options.apiKeyFlag) return { apiKey: options.apiKeyFlag, url, profile: profileName, source: "flag" };
  const fromEnv = process.env.KANERA_API_KEY;
  if (fromEnv && fromEnv.trim() !== "") return { apiKey: fromEnv.trim(), url, profile: profileName, source: "env" };
  if (stored) return { apiKey: stored.apiKey, url, profile: profileName, source: "profile" };

  throw new CliError(
    `no Kanera credential for profile "${profileName}"`,
    EXIT.unauthenticated,
    "Run `kanera auth login`, or set KANERA_API_KEY.",
  );
}

export function saveProfile(name: string, profile: Profile, makeDefault: boolean): void {
  const config = readConfig();
  config.profiles[name] = profile;
  if (makeDefault || Object.keys(config.profiles).length === 1) config.defaultProfile = name;
  writeConfig(config);
}

export function removeProfile(name: string): boolean {
  const config = readConfig();
  if (!(name in config.profiles)) return false;
  delete config.profiles[name];
  if (config.defaultProfile === name) config.defaultProfile = Object.keys(config.profiles)[0] ?? "default";
  if (Object.keys(config.profiles).length === 0) rmSync(configPath(), { force: true });
  else writeConfig(config);
  return true;
}
