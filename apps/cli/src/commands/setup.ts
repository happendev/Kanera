import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CommandContext, CommandResult } from "../context.js";
import { CliError, EXIT, usageError } from "../errors.js";
import { agentsSection, skillDocument } from "../skill.js";

/** Human output is the sentence; the paths stay available under --json for scripted setup. */
function summarised(summary: string, data: unknown): CommandResult {
  return { summary, raw: summary, data };
}

export function setupCommand(ctx: CommandContext): CommandResult {
  const target = ctx.positionals[1];
  switch (target) {
    case "claude": return setupClaude(ctx);
    case "codex":
    case "agents": return setupAgents(ctx);
    default: throw usageError(`unknown setup target "${target ?? ""}"`, "Try: kanera setup claude, kanera setup codex");
  }
}

function writeOnce(path: string, contents: string, force: boolean): { path: string; written: boolean } {
  if (existsSync(path) && !force) {
    throw new CliError(`${path} already exists`, EXIT.failed, "Re-run with --force to replace it.");
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return { path, written: true };
}

function setupClaude(ctx: CommandContext): CommandResult {
  const root = ctx.flags.global === true ? homedir() : process.cwd();
  const path = join(root, ".claude", "skills", "kanera", "SKILL.md");
  const result = writeOnce(path, skillDocument(), ctx.flags.force === true);
  const summary = `Wrote the Kanera skill to ${result.path}.\nClaude Code will load it in this ${ctx.flags.global === true ? "account" : "project"}.`;
  return {
    summary,
    raw: summary,
    data: result,
  };
}

function setupAgents(ctx: CommandContext): CommandResult {
  const path = join(process.cwd(), "AGENTS.md");
  const section = agentsSection();
  if (!existsSync(path)) {
    writeFileSync(path, `# Agent instructions\n\n${section}`);
    return summarised(`Created ${path} with Kanera instructions.`, { path, written: true, appended: false });
  }
  const existing = readFileSync(path, "utf8");
  // Idempotent by design: `setup` is the kind of command people re-run after an upgrade, and it
  // must not stack duplicate sections into a file the user also edits by hand.
  if (existing.includes("kanera commands --json") && ctx.flags.force !== true) {
    return summarised(`${path} already documents Kanera; nothing to do.`, { path, written: false, appended: false });
  }
  writeFileSync(path, `${existing.replace(/\s*$/u, "")}\n\n${section}`);
  return summarised(`Appended Kanera instructions to ${path}.`, { path, written: true, appended: true });
}
