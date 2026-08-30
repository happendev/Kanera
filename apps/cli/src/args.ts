import { usageError } from "./errors.js";

export type RawFlag = string | string[] | boolean;

export interface ParsedArgs {
  /** Non-flag tokens in order: the command path plus any positionals. */
  positionals: string[];
  flags: Record<string, RawFlag>;
}

const SHORT_FLAGS: Record<string, string> = { h: "help", v: "version", q: "quiet", j: "json" };

function isLongFlag(token: string): boolean {
  return token.startsWith("--") && token.length > 2;
}

function appendFlag(flags: Record<string, RawFlag>, name: string, value: RawFlag): void {
  const existing = flags[name];
  if (existing === undefined) {
    flags[name] = value;
    return;
  }
  // Repeating a flag builds an array so `--boardIds a --boardIds b` fills an array-typed tool
  // argument without the caller reaching for `--json`.
  const merged = Array.isArray(existing) ? existing : [String(existing)];
  flags[name] = [...merged, ...(Array.isArray(value) ? value : [String(value)])];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, RawFlag> = {};
  let literal = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (literal) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      literal = true;
      continue;
    }
    if (isLongFlag(token)) {
      const body = token.slice(2);
      const equals = body.indexOf("=");
      if (equals !== -1) {
        appendFlag(flags, body.slice(0, equals), body.slice(equals + 1));
        continue;
      }
      if (body.startsWith("no-")) {
        flags[body.slice(3)] = false;
        continue;
      }
      const next = argv[i + 1];
      // A bare `--flag` is boolean; `--flag value` consumes the value. Only `--`-prefixed tokens
      // terminate a flag, so negative numbers and card keys survive as values.
      if (next === undefined || isLongFlag(next) || next === "--") {
        flags[body] = true;
        continue;
      }
      appendFlag(flags, body, next);
      i += 1;
      continue;
    }
    if (/^-[a-z]$/u.test(token)) {
      const name = SHORT_FLAGS[token.slice(1)];
      if (!name) throw usageError(`unknown flag ${token}`);
      flags[name] = true;
      continue;
    }
    positionals.push(token);
  }

  return { positionals, flags };
}

/**
 * Flags the CLI consumes itself. Everything else is treated as tool input, so this list is also
 * the set of names a tool argument may not use.
 */
export const GLOBAL_FLAGS = new Set([
  "help", "version", "json", "quiet", "profile", "api-key", "url", "yes", "force", "browser",
]);

/**
 * Expand dotted and bracketed flag names into a nested payload:
 * `--changes.title X` -> `{ changes: { title: "X" } }`, `--boardIds[] a` -> `{ boardIds: ["a"] }`.
 * Many tool inputs are nested objects (card `changes`, work `filters`, work `scope`), and forcing
 * `--json` for every one of those would make the ergonomic commands pointless.
 */
export function expandFlagPaths(flags: Record<string, RawFlag>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(flags)) {
    if (GLOBAL_FLAGS.has(name)) continue;
    const forceArray = name.endsWith("[]");
    const path = (forceArray ? name.slice(0, -2) : name).split(".");
    const leaf = path.pop()!;
    let cursor = payload;
    for (const segment of path) {
      const next = cursor[segment];
      if (next === undefined) cursor[segment] = {};
      else if (typeof next !== "object" || next === null || Array.isArray(next)) {
        throw usageError(`--${name} conflicts with an earlier value for --${path.join(".")}`);
      }
      cursor = cursor[segment] as Record<string, unknown>;
    }
    cursor[leaf] = forceArray && !Array.isArray(value) ? [value] : value;
  }
  return payload;
}

export function stringFlag(flags: Record<string, RawFlag>, name: string): string | undefined {
  const value = flags[name];
  if (value === undefined || typeof value === "boolean") return undefined;
  return Array.isArray(value) ? value.at(-1) : value;
}

export function boolFlag(flags: Record<string, RawFlag>, name: string): boolean {
  return flags[name] === true;
}
