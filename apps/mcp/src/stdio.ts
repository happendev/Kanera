import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { env } from "./env.js";
import { createKaneraMcpServer } from "./server.js";

const apiKey = process.env.KANERA_API_KEY;
if (!apiKey?.startsWith("kanera_")) {
  console.error("Set KANERA_API_KEY to a Kanera API key (workspace or personal) before starting the stdio MCP bridge.");
  process.exit(1);
}

// serveStdio answers a 2026-07-28 server/discover probe and pins a client that opens with the
// 2025-era initialize handshake to a legacy instance from the same factory.
serveStdio(() => createKaneraMcpServer({ apiKey, publicApiUrl: env.KANERA_PUBLIC_API_URL }));
