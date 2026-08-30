import { COMMAND_ALIASES } from "../aliases.js";
import type { CommandContext, CommandResult } from "../context.js";
import { usageError } from "../errors.js";
import type { JsonSchema, ToolCatalogEntry } from "../tools.js";

const BUILTIN_HELP: Record<string, { usage: string; description: string }> = {
  auth: { usage: "kanera auth <login|status|logout|token|list>", description: "Manage saved Kanera credentials and profiles." },
  "auth login": { usage: "kanera auth login [--profile name] [--api-key key] [--url origin] [--no-browser]", description: "Validate and store a Kanera API key." },
  "auth status": { usage: "kanera auth status [--profile name]", description: "Show the active profile, identity, and credential scope." },
  "auth logout": { usage: "kanera auth logout [--profile name]", description: "Remove one locally stored profile." },
  "auth token": { usage: "kanera auth token [--profile name]", description: "Print the active API key for command substitution." },
  "auth list": { usage: "kanera auth list", description: "List locally stored profiles without printing secrets." },
  commands: { usage: "kanera commands [filter] [--json]", description: "List the complete command and tool catalog without requiring authentication." },
  doctor: { usage: "kanera doctor", description: "Diagnose the runtime, configuration, credential, and API connection." },
  mcp: { usage: "kanera mcp", description: "Serve Kanera's tools over stdio MCP using the active CLI credential." },
  setup: { usage: "kanera setup <claude|codex>", description: "Install Kanera instructions for a coding agent." },
  skill: { usage: "kanera skill", description: "Print the portable Kanera Agent Skill document." },
};

function typeName(schema: JsonSchema): string {
  if (Array.isArray(schema.type)) return schema.type.join("|");
  if (schema.type) return schema.type === "array" && schema.items ? `${typeName(schema.items)}[]` : schema.type;
  // Zod unions and discriminated unions arrive as anyOf/oneOf with no top-level type; naming the
  // members is more useful to a caller than reporting "any".
  const members = schema.anyOf ?? schema.oneOf;
  if (members) return [...new Set(members.map(typeName))].join(" | ");
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  return "any";
}

function argumentSummary(schema: JsonSchema): { name: string; type: string; required: boolean; description?: string }[] {
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([name, property]) => ({
    name,
    type: typeName(property),
    required: required.has(name),
    description: property.description,
  }));
}

/**
 * The catalog is how an agent learns this CLI without a human writing documentation for it: one
 * `kanera commands --json` returns every tool, its arguments, and whether it mutates. Basecamp's
 * CLI does the same thing, and it is the reason a new MCP tool is usable from the shell the day it
 * ships rather than the day someone remembers to add an alias for it.
 */
export async function commandsCommand(ctx: CommandContext): Promise<CommandResult> {
  const session = await ctx.catalogSession();
  const filter = ctx.positionals[1]?.toLowerCase();
  const tools = filter
    ? session.tools.filter((tool) => tool.name.includes(filter) || tool.description.toLowerCase().includes(filter))
    : session.tools;

  if (ctx.mode === "human") {
    return { summary: renderHumanCatalog(tools), data: { tools: tools.map((tool) => ({ name: tool.name })) }, raw: renderHumanCatalog(tools) };
  }
  return {
    data: {
      aliases: COMMAND_ALIASES.map((alias) => ({
        command: `kanera ${alias.path.join(" ")}`,
        tool: alias.tool,
        summary: alias.summary,
        positionals: alias.positionals ?? [],
        defaults: alias.defaults ?? {},
      })),
      tools: tools.map((tool) => ({
        name: tool.name,
        command: `kanera call ${tool.name}`,
        title: tool.title,
        description: tool.description,
        readOnly: tool.readOnly,
        destructive: tool.destructive,
        arguments: argumentSummary(tool.inputSchema),
        inputSchema: tool.inputSchema,
      })),
    },
  };
}

function renderHumanCatalog(tools: ToolCatalogEntry[]): string {
  const groups = new Map<string, string[]>();
  for (const alias of COMMAND_ALIASES) {
    const lines = groups.get(alias.group) ?? [];
    lines.push(`  kanera ${[...alias.path, ...(alias.positionals ?? []).map((name) => `<${name}>`)].join(" ")}`.padEnd(52) + alias.summary);
    groups.set(alias.group, lines);
  }
  const sections = [...groups].map(([group, lines]) => `${group}\n${lines.join("\n")}`);
  const footer = [
    `${tools.length} tools are callable directly, including every command above:`,
    "  kanera call <tool> [--arg value]",
    "  kanera help <tool>                                Show one tool's arguments",
    "  kanera commands --json                            Machine-readable catalog of all of them",
  ].join("\n");
  return [...sections, footer].join("\n\n");
}

export async function helpCommand(ctx: CommandContext): Promise<CommandResult> {
  const name = ctx.positionals.slice(1).join(" ");
  if (!name) throw usageError("help needs a tool or command name", "Run `kanera commands` to list them.");
  const builtin = BUILTIN_HELP[name];
  if (builtin) {
    const text = `${builtin.usage}\n\n${builtin.description}`;
    return { summary: text, raw: text, data: { command: name, ...builtin } };
  }
  const session = await ctx.catalogSession();
  const alias = COMMAND_ALIASES.find((entry) => entry.path.join(" ") === name);
  const tool = session.tools.find((entry) => entry.name === name)
    ?? (alias ? session.tool(alias.tool) : undefined);
  if (!tool) throw usageError(`no command or tool named "${name}"`, "Run `kanera commands` to list them.");

  const args = argumentSummary(tool.inputSchema);
  const lines = [
    `${tool.name}${tool.readOnly ? "  (read-only)" : tool.destructive ? "  (changes data)" : "  (adds data)"}`,
    "",
    tool.description,
    "",
    "Arguments:",
    ...(args.length === 0
      ? ["  (none)"]
      : args.map((arg) => `  --${arg.name}`.padEnd(28) + `${arg.type}${arg.required ? " (required)" : ""}${arg.description ? ` — ${arg.description}` : ""}`)),
  ];
  if (args.some((arg) => arg.type.includes("object") || arg.type.includes("[]") || arg.type.includes(" | "))) {
    lines.push("", `Nested fields and constraints: kanera help ${tool.name} --json`);
  }
  return {
    summary: lines.join("\n"),
    raw: lines.join("\n"),
    data: { tool: tool.name, arguments: args, inputSchema: tool.inputSchema },
  };
}
