import { existsSync, statSync } from "node:fs";
import { configPath, resolveCredential } from "../config.js";
import type { CommandContext, CommandResult } from "../context.js";
import { CliError, EXIT } from "../errors.js";
import { ApiFailure, openToolSession } from "../tools.js";

interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

/**
 * Diagnose the two things that actually go wrong in the field: the credential the CLI picked is not
 * the one the user thinks it is, and the credential cannot do what they are about to ask of it.
 * Everything reported here is read-only — doctor never probes by mutating.
 */
export async function doctorCommand(ctx: CommandContext): Promise<CommandResult> {
  const checks: Check[] = [];

  const major = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "node",
    status: major >= 22 ? "ok" : "fail",
    detail: `v${process.versions.node}${major >= 22 ? "" : " (Kanera needs Node 22 or newer)"}`,
  });

  const path = configPath();
  if (!existsSync(path)) {
    checks.push({ name: "config", status: "warn", detail: `${path} does not exist (using flags or KANERA_API_KEY)` });
  } else {
    const mode = statSync(path).mode & 0o777;
    checks.push({
      name: "config",
      status: mode === 0o600 ? "ok" : "warn",
      detail: `${path} (mode ${mode.toString(8).padStart(3, "0")}${mode === 0o600 ? "" : ", expected 600 — it holds API keys"})`,
    });
  }

  let credential;
  try {
    credential = resolveCredential({ apiKeyFlag: ctx.apiKeyFlag, urlFlag: ctx.urlFlag, profileFlag: ctx.profileFlag });
    checks.push({ name: "credential", status: "ok", detail: `profile "${credential.profile}" from ${credential.source}` });
    checks.push({ name: "endpoint", status: "ok", detail: credential.url });
  } catch (error) {
    checks.push({ name: "credential", status: "fail", detail: error instanceof Error ? error.message : String(error) });
    return finish(checks);
  }

  const startedAt = performance.now();
  try {
    const session = await openToolSession({ apiKey: credential.apiKey, publicApiUrl: credential.url });
    try {
      const result = await session.call("session.get", {}) as {
        scope?: string | null; userId?: string; organisationName?: string; credentialKind?: string;
      };
      const elapsed = Math.round(performance.now() - startedAt);
      checks.push({ name: "reachable", status: "ok", detail: `${credential.url} responded in ${elapsed}ms` });
      checks.push({
        name: "identity",
        status: "ok",
        detail: `${result.userId ?? "unknown user"} in ${result.organisationName ?? "unknown organisation"}`
          + ` (${result.credentialKind ?? "unknown"} credential)`,
      });
      checks.push({
        name: "scope",
        status: "ok",
        // Not a warning: read-only is the recommended setting for an agent credential, so flagging
        // it as a problem would push people toward the less safe choice.
        detail: result.scope === "read" ? "read (this credential cannot change anything)" : String(result.scope ?? "unknown"),
      });
      checks.push({ name: "tools", status: "ok", detail: `${session.tools.length} commands available` });
    } finally {
      await session.close();
    }
  } catch (error) {
    checks.push({
      name: "reachable",
      status: "fail",
      detail: error instanceof ApiFailure ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error),
    });
  }

  return finish(checks);
}

function finish(checks: Check[]): CommandResult {
  const failed = checks.filter((check) => check.status === "fail");
  const summary = checks
    .map((check) => `${check.status === "ok" ? "✓" : check.status === "warn" ? "!" : "✗"} ${check.name.padEnd(11)} ${check.detail}`)
    .join("\n");
  if (failed.length > 0) throw new CliError(summary, EXIT.failed);
  return { summary, raw: summary, data: { checks } };
}
