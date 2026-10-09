export const MCP_RESOURCE_SCOPES = ["kanera:read", "kanera:write"] as const;

export function mcpAuthorizationChallenge(resource: string, error?: "invalid_token") {
  const metadata = new URL("/.well-known/oauth-protected-resource", resource);
  // The server exposes both reads and writes; requesting only read would strand an
  // interactive connection with a valid token that cannot perform approved writes.
  return `Bearer resource_metadata="${metadata.toString()}", scope="${MCP_RESOURCE_SCOPES.join(" ")}"${error ? ', error="invalid_token", error_description="Reconnect Kanera to renew your access token"' : ""}`;
}
