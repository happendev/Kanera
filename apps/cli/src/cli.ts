import { applyPositionals, matchAlias } from "./aliases.js";
import { boolFlag, expandFlagPaths, parseArgs, stringFlag } from "./args.js";
import { authCommand } from "./commands/auth.js";
import { commandsCommand, helpCommand } from "./commands/catalog.js";
import { doctorCommand } from "./commands/doctor.js";
import { setupCommand } from "./commands/setup.js";
import { resolveCredential } from "./config.js";
import type { CommandContext, CommandResult } from "./context.js";
import { CliError, EXIT, type ExitCode } from "./errors.js";
import { outputMode, render } from "./output.js";
import { skillDocument } from "./skill.js";
import { ApiFailure, coerceArguments, openToolSession, type ToolSession } from "./tools.js";

declare const KANERA_CLI_VERSION: string;
// Source-level tests and `tsx` development runs bypass the bundler. Published builds replace the
// identifier at compile time, so a copied executable never needs a neighbouring package.json.
const cliVersion = typeof KANERA_CLI_VERSION === "undefined"
  ? process.env.npm_package_version ?? "0.0.0-dev"
  : KANERA_CLI_VERSION;

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const USAGE = `kanera — manage Kanera work from the terminal or an AI agent

Usage:
  kanera <command> [arguments] [--flags]

Getting started:
  kanera auth login                    Store a personal API key (read-only keys are ideal for agents)
  kanera whoami                        Show the credential and its scope
  kanera commands                      List every available command
  kanera skill                         Print the portable Agent Skill document
  kanera setup claude                  Install the Kanera skill for Claude Code
  kanera doctor                        Diagnose credentials and connectivity

Anything in the catalog is callable directly:
  kanera call <tool> [--arg value]
  kanera help <tool>

Global flags:
  --json              Structured envelope: { ok, tool, data }
  --quiet             Bare result JSON, for piping into jq
  --profile <name>    Use a named credential profile
  --api-key <key>     Use this key for one command (or set KANERA_API_KEY)
  --url <origin>      Point at a different Kanera API (or set KANERA_PUBLIC_API_URL)
`;

export async function run(argv: string[], io: Io): Promise<ExitCode> {
  // `pnpm cli -- <args>` arrives with one `--` per pnpm layer that forwarded it. A leading `--`
  // cannot mean "end of flags" when no flags precede it, so they are dropped rather than allowed to
  // push the whole command line into literal mode.
  let start = 0;
  while (argv[start] === "--") start += 1;
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(argv.slice(start));
  } catch (error) {
    return reportFailure(error, "human", io);
  }
  let { positionals } = parsed;
  const { flags } = parsed;
  const mode = outputMode({ json: boolFlag(flags, "json"), quiet: boolFlag(flags, "quiet") });

  if (boolFlag(flags, "version")) {
    io.stdout(`${cliVersion}\n`);
    return EXIT.ok;
  }
  if (positionals.length === 0 || (boolFlag(flags, "help") && positionals.length === 0)) {
    io.stdout(USAGE);
    return EXIT.ok;
  }

  if (boolFlag(flags, "help")) {
    // Help must never execute the command it documents. `call` is transport syntax rather than
    // part of the tool's name, while alias paths such as `card done` are kept intact.
    positionals = positionals[0] === "call" && positionals[1]
      ? ["help", positionals[1]]
      : ["help", ...positionals];
  }

  let opened: ToolSession | undefined;
  let catalogOpened: ToolSession | undefined;
  const ctx: CommandContext = {
    positionals,
    flags,
    apiKeyFlag: stringFlag(flags, "api-key"),
    urlFlag: stringFlag(flags, "url"),
    profileFlag: stringFlag(flags, "profile"),
    mode,
    async session() {
      if (!opened) {
        const credential = resolveCredential({
          apiKeyFlag: ctx.apiKeyFlag,
          urlFlag: ctx.urlFlag,
          profileFlag: ctx.profileFlag,
        });
        opened = await openToolSession({ apiKey: credential.apiKey, publicApiUrl: credential.url });
      }
      return opened;
    },
    async catalogSession() {
      if (!catalogOpened) {
        // Tool registration and tools/list are local operations; the placeholder is never sent to
        // Kanera. Keeping discovery credential-free lets an agent learn how to authenticate.
        catalogOpened = await openToolSession({
          apiKey: "kanera_u_offline_catalog",
          publicApiUrl: "https://api.kanera.app",
        });
      }
      return catalogOpened;
    },
  };

  try {
    // `mcp` replaces the process's stdio with an MCP transport, so it can never fall through to the
    // renderer below; it is handled before anything writes to stdout.
    if (positionals[0] === "mcp") return await serveMcp(ctx);

    const result = await dispatch(ctx);
    const text = mode === "human" && result.raw !== undefined
      ? result.raw
      : render(mode, { ok: true, tool: result.tool, data: result.data, summary: result.summary });
    io.stdout(text.endsWith("\n") ? text : `${text}\n`);
    return EXIT.ok;
  } catch (error) {
    return reportFailure(error, mode, io);
  } finally {
    await opened?.close();
    await catalogOpened?.close();
  }
}

async function dispatch(ctx: CommandContext): Promise<CommandResult> {
  const [command] = ctx.positionals;
  switch (command) {
    case "auth": assertPositionals(ctx, 2, "kanera auth <login|status|logout|token|list>"); return await authCommand(ctx);
    case "commands": assertPositionals(ctx, 2, "kanera commands [filter]"); return await commandsCommand(ctx);
    case "help": return await helpCommand(ctx);
    case "setup": assertPositionals(ctx, 2, "kanera setup <claude|codex>"); return setupCommand(ctx);
    case "doctor": assertPositionals(ctx, 1, "kanera doctor"); return await doctorCommand(ctx);
    case "skill": assertPositionals(ctx, 1, "kanera skill"); return { raw: skillDocument(), data: { document: skillDocument() } };
    case "call": return await callTool(ctx);
    default: return await callAlias(ctx);
  }
}

function assertPositionals(ctx: CommandContext, maximum: number, expected: string): void {
  if (ctx.positionals.length > maximum) {
    throw new CliError(`too many arguments for "${ctx.positionals.slice(0, maximum).join(" ")}"`, EXIT.usage, `Expected: ${expected}`);
  }
}

/** Build the tool arguments for a call: alias defaults and positionals, then explicit flags. */
function toolArguments(ctx: CommandContext, assigned: Record<string, unknown>): Record<string, unknown> {
  const fromJson = stringFlag(ctx.flags, "json-args");
  let parsed: Record<string, unknown> = {};
  if (fromJson !== undefined) {
    try {
      const value = JSON.parse(fromJson) as unknown;
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("expected a JSON object");
      parsed = value as Record<string, unknown>;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new CliError(`--json-args is not a valid JSON object: ${detail}`, EXIT.usage);
    }
  }
  const { "json-args": _ignored, ...rest } = ctx.flags;
  return { ...assigned, ...parsed, ...expandFlagPaths(rest) };
}

async function callTool(ctx: CommandContext): Promise<CommandResult> {
  assertPositionals(ctx, 2, "kanera call <tool> [--arg value]");
  const name = ctx.positionals[1];
  if (!name) throw new CliError("call needs a tool name", EXIT.usage, "Run `kanera commands` to list them.");
  const session = await ctx.session();
  const tool = session.tool(name);
  const args = coerceArguments(tool, toolArguments(ctx, {}));
  return { tool: tool.name, data: await session.call(tool.name, args) };
}

async function callAlias(ctx: CommandContext): Promise<CommandResult> {
  const match = matchAlias(ctx.positionals);
  if (!match) {
    // A bare tool name works too, so `kanera kanera_get_card MKT-42` behaves like `kanera call`.
    const direct = ctx.positionals[0];
    if (direct?.startsWith("kanera_")) {
      const positional = ctx.positionals.slice(1);
      if (positional.length > 1) {
        throw new CliError(`too many positional arguments for ${direct}`, EXIT.usage, `Use flags or \`kanera help ${direct} --json\`.`);
      }
      const session = await ctx.session();
      const tool = session.tool(direct);
      const first = Object.keys(tool.inputSchema.properties ?? {})[0];
      const assigned = positional.length > 0 && first ? { [first]: positional[0] } : {};
      return { tool: tool.name, data: await session.call(tool.name, coerceArguments(tool, toolArguments(ctx, assigned))) };
    }
    throw new CliError(`unknown command "${ctx.positionals.join(" ")}"`, EXIT.usage, "Run `kanera commands` to list them.");
  }
  const assigned = applyPositionals(match.alias, match.rest);
  const session = await ctx.session();
  const tool = session.tool(match.alias.tool);
  const args = coerceArguments(tool, toolArguments(ctx, assigned));
  return { tool: tool.name, data: await session.call(tool.name, args) };
}

/**
 * Serve the same tool layer over stdio MCP using the CLI's stored credential, so a user who has run
 * `kanera auth login` can point Claude Code or Codex at `kanera mcp` without configuring a second
 * credential in a second place.
 */
async function serveMcp(ctx: CommandContext): Promise<ExitCode> {
  const credential = resolveCredential({
    apiKeyFlag: ctx.apiKeyFlag,
    urlFlag: ctx.urlFlag,
    profileFlag: ctx.profileFlag,
  });
  const [{ createKaneraMcpServer }, { StdioServerTransport }] = await Promise.all([
    import("@kanera/mcp/server"),
    import("@modelcontextprotocol/sdk/server/stdio.js"),
  ]);
  const server = createKaneraMcpServer({
    apiKey: credential.apiKey,
    publicApiUrl: credential.url,
    // stdout is the MCP transport here, so tool telemetry must stay off it.
    logToolCalls: false,
  });
  await server.connect(new StdioServerTransport());
  // Stay alive until the host closes the transport; there is nothing to render and no exit point.
  await new Promise<void>((resolve) => {
    server.server.onclose = resolve;
  });
  return EXIT.ok;
}

function reportFailure(error: unknown, mode: ReturnType<typeof outputMode>, io: Io): ExitCode {
  const failure = error instanceof ApiFailure
    ? {
        status: error.status,
        code: error.code,
        message: error.message,
        exitCode: error.exitCode,
        retryable: error.retryable,
        retryAfter: error.retryAfter,
      }
    : error instanceof CliError
      ? { message: error.message, hint: error.hint, exitCode: error.exitCode }
      : { message: error instanceof Error ? error.message : String(error), exitCode: EXIT.failed };
  const text = render(mode, { ok: false, error: failure });
  // Failures go to stderr even in --json mode so a caller redirecting stdout to a file never mixes
  // an error envelope into what it believes is result data.
  io.stderr(text.endsWith("\n") ? text : `${text}\n`);
  return failure.exitCode as ExitCode;
}
