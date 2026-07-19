export const KANERA_AGENT_SETUP_PROMPT_URL = "https://www.kanera.app/agent-setup/prompt.md";

export function buildAgentSetupPrompt(mcpUrl: string): string {
  return [
    `Fetch ${KANERA_AGENT_SETUP_PROMPT_URL} and follow it.`,
    "",
    "Use this Kanera MCP address instead of the hosted default:",
    mcpUrl.trim(),
  ].join("\n");
}
