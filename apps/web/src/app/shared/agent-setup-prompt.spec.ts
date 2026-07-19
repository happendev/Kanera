import { describe, expect, it } from "vitest";
import { buildAgentSetupPrompt, KANERA_AGENT_SETUP_PROMPT_URL } from "./agent-setup-prompt";

describe("buildAgentSetupPrompt", () => {
  it("includes the public setup prompt and the current Kanera MCP address", () => {
    expect(buildAgentSetupPrompt("  https://kanera.example.com/mcp  ")).toBe([
      `Fetch ${KANERA_AGENT_SETUP_PROMPT_URL} and follow it.`,
      "",
      "Use this Kanera MCP address instead of the hosted default:",
      "https://kanera.example.com/mcp",
    ].join("\n"));
  });
});
