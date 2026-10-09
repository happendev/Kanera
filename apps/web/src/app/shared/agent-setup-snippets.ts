/**
 * Copy-paste MCP client configuration for the "Connect an AI agent" card. These are the OAuth
 * variants only: the agent signs in through the browser, so no key is ever placed in a snippet.
 * Formats mirror the per-client setup guides on the docs site (docs/ai-mcp-*.md in Kanera-site).
 */
export type AgentSnippetClient = "claude-code" | "cursor" | "vscode" | "codex" | "gemini";

export interface AgentSetupSnippet {
  client: AgentSnippetClient;
  label: string;
  /** Where the snippet goes, shown above the code. */
  where: string;
  code: string;
}

export const AGENT_SNIPPET_CLIENTS: ReadonlyArray<{ id: AgentSnippetClient; label: string }> = [
  { id: "claude-code", label: "Claude Code" },
  { id: "cursor", label: "Cursor" },
  { id: "vscode", label: "VS Code / GitHub Copilot" },
  { id: "codex", label: "Codex" },
  { id: "gemini", label: "Gemini CLI" },
];

const SERVER_NAME = "kanera";

export function buildAgentSetupSnippet(client: AgentSnippetClient, mcpUrl: string): AgentSetupSnippet {
  const url = mcpUrl.trim();
  const label = AGENT_SNIPPET_CLIENTS.find((entry) => entry.id === client)!.label;
  switch (client) {
    case "claude-code":
      return { client, label, where: "Run in a terminal, then run /mcp in Claude Code to sign in.", code: `claude mcp add --transport http ${SERVER_NAME} --scope user ${url}` };
    case "cursor":
      return { client, label, where: "Add to ~/.cursor/mcp.json. Cursor asks you to sign in on first use.", code: json({ mcpServers: { [SERVER_NAME]: { url } } }) };
    case "vscode":
      return { client, label, where: "Add to your user or .vscode/mcp.json, then run \"MCP: List Servers\".", code: json({ servers: { [SERVER_NAME]: { type: "http", url } } }) };
    case "codex":
      return { client, label, where: `Add to ~/.codex/config.toml, then run codex mcp login ${SERVER_NAME}.`, code: `[mcp_servers.${SERVER_NAME}]\nurl = "${url}"` };
    case "gemini":
      return { client, label, where: `Add to ~/.gemini/settings.json, then run /mcp auth ${SERVER_NAME}.`, code: json({ mcpServers: { [SERVER_NAME]: { httpUrl: url } } }) };
  }
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
