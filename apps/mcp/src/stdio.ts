import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { env } from "./env.js";
import { createKaneraMcpServer } from "./server.js";

const apiKey = process.env.KANERA_API_KEY;
if (!apiKey?.startsWith("kanera_")) {
  console.error("Set KANERA_API_KEY to a Kanera API key (workspace or personal) before starting the stdio MCP bridge.");
  process.exit(1);
}

const server = createKaneraMcpServer({ apiKey, publicApiUrl: env.KANERA_PUBLIC_API_URL });
await server.connect(new StdioServerTransport());
