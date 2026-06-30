import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { env } from "./env.js";
import { createKaneraMcpServer } from "./server.js";

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (!body) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(body) as unknown);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    req.on("error", reject);
  });
}

export function mcpRequestPathname(url: string | undefined) {
  return new URL(url ?? "/", "http://localhost").pathname;
}

export function createMcpHttpHandler() {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const pathname = mcpRequestPathname(req.url);
    if (pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "mcp" }));
      return;
    }
    if (pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const authorization = req.headers.authorization;
    if (!authorization?.startsWith("Bearer kanera_")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "missing Kanera API key bearer token" }));
      return;
    }
    const mcp = createKaneraMcpServer({ apiKey: authorization.slice("Bearer ".length) });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);
    try {
      const body = req.method === "POST" ? await readBody(req) : undefined;
      await transport.handleRequest(req, res, body);
    } finally {
      await mcp.close();
    }
  };
}

export function startMcpHttpServer() {
  const httpServer = createServer(createMcpHttpHandler());
  httpServer.listen(env.MCP_PORT, () => {
    console.log(`Kanera MCP server listening on http://localhost:${env.MCP_PORT}/mcp`);
  });
  return httpServer;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startMcpHttpServer();
}
