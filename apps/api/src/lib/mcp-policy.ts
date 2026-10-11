import type { ClientMcpPolicy } from "@kanera/shared/schema";
import type { AuthClaims } from "../auth/plugin.js";
import { env } from "../env.js";
import { forbidden } from "./errors.js";

/**
 * An organisation's MCP policy is a hosted-only control: self-hosted operators decide agent access
 * by running (or not running) the MCP server, so the stored value is ignored there.
 */
export function effectiveMcpPolicy(policy: ClientMcpPolicy): ClientMcpPolicy {
  return env.KANERA_DEPLOYMENT_MODE === "hosted" ? policy : "write";
}

const agentAccessDisabled = () => forbidden("AI agent access is turned off for this organisation");

/**
 * Cap a personal agent credential (OAuth agent grant or personal API key) by the policy of the
 * organisation it is currently acting in. Personal credentials rebase onto each resource's
 * organisation, so the cap is recomputed from the credential's own scope every time rather than
 * compounding: a grant downgraded in a read-only organisation regains write in a permissive one.
 * Workspace keys and service connections are admin-issued integrations and are left untouched.
 */
export function applyMcpPolicy(claims: AuthClaims, policy: ClientMcpPolicy): void {
  if (claims.apiKeyKind !== "personal") return;
  const effective = effectiveMcpPolicy(policy);
  const granted = claims.apiKeyGrantedScope ?? claims.apiKeyScope;
  claims.apiKeyGrantedScope = granted;
  claims.mcpPolicy = effective;
  claims.apiKeyScope = effective === "write" ? granted : "read";
}

/** Throws when the credential's current organisation has turned agent access off. */
export function assertAgentAccessAllowed(claims: AuthClaims): void {
  if (claims.apiKeyKind === "personal" && claims.mcpPolicy === "off") throw agentAccessDisabled();
}
