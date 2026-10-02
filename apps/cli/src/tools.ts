import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError, ResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { CliError, EXIT, exitCodeForApiError, usageError } from "./errors.js";

export interface ToolCatalogEntry {
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonSchema;
  readOnly: boolean;
  destructive: boolean;
}

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: unknown[];
  default?: unknown;
  description?: string;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  definitions?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
}

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfter?: string,
  ) {
    super(message);
    this.name = "ApiFailure";
  }

  get exitCode() {
    return exitCodeForApiError(this.status, this.code);
  }

  get retryable() {
    return this.status === 408 || this.status === 429 || (this.status >= 500 && this.status !== 501);
  }
}

export interface ToolSession {
  tools: ToolCatalogEntry[];
  tool(name: string): ToolCatalogEntry;
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export type ToolSessionOptions =
  | { apiKey: string; publicApiUrl: string }
  | {
      /** The remote MCP endpoint an OAuth sign-in is bound to. */
      mcpUrl: string;
      /** Called for every request so a long-lived session (`kanera mcp`) outlives one access token. */
      accessToken: (options?: { force?: boolean }) => Promise<string>;
    };

/**
 * Open an MCP session against the same tool layer the hosted MCP server exposes.
 *
 * The CLI is deliberately a second transport onto that layer rather than a third client of the
 * public REST API: card-reference resolution (`PROJ-12`), cursor encoding, response size caps, and
 * every tool description already live there, so a command surface built on it cannot drift from
 * what agents see over MCP.
 *
 * An API key runs that layer in-process: nothing crosses a socket, the linked pair is two ends of
 * an array. An OAuth sign-in cannot, because its tokens are bound to the MCP endpoint and are never
 * accepted by `/api/v1`, so it talks to the remote MCP server exactly as Claude or Codex would.
 */
export async function openToolSession(options: ToolSessionOptions): Promise<ToolSession> {
  const client = new Client({ name: "kanera-cli", version: "1.0.0" }, { capabilities: {} });
  let closeServer: () => Promise<void> = async () => {};
  if ("mcpUrl" in options) {
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    await client.connect(new StreamableHTTPClientTransport(new URL(options.mcpUrl), {
      fetch: (input, init) => authorizedFetch(input, init, options.accessToken),
    }));
  } else {
    // Imported lazily so main.ts can normalise MCP_* environment defaults before @kanera/mcp parses
    // process.env at module load; a stray NODE_ENV=production in a user's shell would otherwise make
    // the CLI demand server-only secrets it has no use for.
    const { createKaneraMcpServer } = await import("@kanera/mcp/server");
    const server = createKaneraMcpServer({
      apiKey: options.apiKey,
      publicApiUrl: options.publicApiUrl,
      // The MCP server writes a JSON telemetry line per tool call. On a socket that is a server log;
      // on a CLI it would corrupt stdout, which agents parse.
      logToolCalls: false,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    closeServer = () => server.close();
  }

  const listed = await client.listTools();
  const tools: ToolCatalogEntry[] = listed.tools.map((entry) => ({
    name: entry.name,
    title: entry.annotations?.title ?? entry.title,
    description: entry.description ?? "",
    inputSchema: (entry.inputSchema ?? {}) as JsonSchema,
    readOnly: entry.annotations?.readOnlyHint === true,
    destructive: entry.annotations?.destructiveHint === true,
  })).sort((a, b) => a.name.localeCompare(b.name));

  return {
    tools,
    tool(name) {
      const found = tools.find((entry) => entry.name === name);
      if (!found) throw new CliError(`unknown tool ${name}`, EXIT.usage, "Run `kanera commands` to list every tool.");
      return found;
    },
    async call(name, args) {
      let result;
      try {
        result = await client.callTool({ name, arguments: args });
      } catch (error) {
        if (error instanceof McpError && error.code === Number(ErrorCode.InvalidParams)) {
          throw usageError(error.message, `Run \`kanera help ${name} --json\` to inspect the complete input schema.`);
        }
        throw error;
      }
      const text = Array.isArray(result.content)
        ? (result.content.find((block) => (block as { type?: string }).type === "text") as { text?: string } | undefined)?.text
        : undefined;
      if (result.isError) throw toApiFailure(text);
      if (result.structuredContent !== undefined) return result.structuredContent;
      return text === undefined ? null : safeParse(text);
    },
    async close() {
      await client.close();
      await closeServer();
    },
  };
}

/**
 * Serve a remote MCP endpoint over a local transport (stdio for `kanera mcp`). Requests are
 * forwarded verbatim, so tools, resources and prompts are whatever the server exposes and the CLI
 * never has to track that surface. Resolves when the host closes the local transport.
 */
export async function proxyRemoteMcp(
  remote: Extract<ToolSessionOptions, { mcpUrl: string }>,
  local: Transport,
): Promise<void> {
  // McpServer only dispatches to tools it registered itself; a verbatim relay needs the low-level
  // Server's fallback handler, which is the "advanced use case" the deprecation notice carves out.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const [{ StreamableHTTPClientTransport }, { Server }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
    import("@modelcontextprotocol/sdk/server/index.js"),
  ]);
  const client = new Client({ name: "kanera-cli", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(remote.mcpUrl), {
    fetch: (input, init) => authorizedFetch(input, init, remote.accessToken),
  }));
  const server = new Server(
    { name: "kanera", version: client.getServerVersion()?.version ?? "1.0.0" },
    { capabilities: client.getServerCapabilities() ?? {}, instructions: client.getInstructions() },
  );
  // initialize and ping are answered locally by Server; everything else goes upstream unchanged.
  server.fallbackRequestHandler = async (request, extra) => await client.request(
    { method: request.method, params: request.params },
    ResultSchema,
    { signal: extra.signal },
  );
  await server.connect(local);
  await new Promise<void>((resolve) => {
    server.onclose = resolve;
  });
  await client.close();
}

/**
 * Attach a current access token to each MCP request. A 401 is retried once with a forced refresh:
 * the stored expiry is only the CLI's estimate, and the server is the authority on whether a token
 * still works. A second 401 means the sign-in itself is gone.
 */
async function authorizedFetch(
  input: string | URL,
  init: RequestInit | undefined,
  accessToken: (options?: { force?: boolean }) => Promise<string>,
): Promise<Response> {
  const send = async (token: string) => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${token}`);
    return await fetch(input, { ...init, headers });
  };
  let response = await send(await accessToken());
  if (response.status === 401) {
    response = await send(await accessToken({ force: true }));
    if (response.status === 401) {
      throw new CliError("Kanera rejected the stored sign-in", EXIT.unauthenticated, "Run `kanera auth login` to sign in again.");
    }
  }
  return response;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toApiFailure(text: string | undefined): ApiFailure {
  const parsed = text === undefined ? undefined : safeParse(text);
  const error = parsed && typeof parsed === "object" ? (parsed as { error?: Record<string, unknown> }).error : undefined;
  if (!error) return new ApiFailure(500, "INTERNAL", text ?? "the Kanera tool call failed");
  return new ApiFailure(
    typeof error.status === "number" ? error.status : 500,
    typeof error.code === "string" ? error.code : "INTERNAL",
    typeof error.message === "string" ? error.message : "the Kanera tool call failed",
    typeof error.retryAfter === "string" ? error.retryAfter : undefined,
  );
}

function deref(schema: JsonSchema, root: JsonSchema): JsonSchema {
  if (!schema.$ref) return schema;
  const name = schema.$ref.split("/").pop();
  if (!name) return schema;
  return root.$defs?.[name] ?? root.definitions?.[name] ?? schema;
}

function schemaTypes(schema: JsonSchema): string[] {
  if (Array.isArray(schema.type)) return schema.type;
  return schema.type ? [schema.type] : [];
}

/**
 * Turn shell strings into the types a tool's input schema expects. Flags always arrive as strings,
 * and guessing from the value alone is wrong — a card key can look numeric and an id can look
 * boolean — so the schema, not the text, decides. Anything the schema does not describe is passed
 * through untouched so the server's own validation produces the error message.
 */
export function coerceToSchema(value: unknown, schema: JsonSchema | undefined, root: JsonSchema = schema ?? {}): unknown {
  if (!schema) return value;
  const resolved = deref(schema, root);
  const candidates = resolved.anyOf ?? resolved.oneOf;
  if (candidates) {
    // Union members are tried in order and the first clean coercion wins; a failure here just means
    // the raw value is forwarded and rejected upstream with a precise message.
    for (const candidate of candidates) {
      const coerced = coerceToSchema(value, candidate, root);
      if (coerced !== value) return coerced;
    }
    return value;
  }
  const types = schemaTypes(resolved);

  if (types.includes("array")) {
    const list = Array.isArray(value) ? value : [value];
    return list.map((entry) => coerceToSchema(entry, resolved.items, root));
  }
  if (types.includes("object") && typeof value === "object" && value !== null && !Array.isArray(value)) {
    const shaped: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      shaped[key] = coerceToSchema(entry, resolved.properties?.[key], root);
    }
    return shaped;
  }
  if (typeof value !== "string") return value;
  if (types.includes("boolean")) {
    if (value === "true" || value === "") return true;
    if (value === "false") return false;
    return value;
  }
  if (types.includes("number") || types.includes("integer")) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  if (types.includes("object")) return safeParse(value);
  return value;
}

export function coerceArguments(tool: ToolCatalogEntry, payload: Record<string, unknown>): Record<string, unknown> {
  const schema = tool.inputSchema;
  const properties = schema.properties ?? {};
  const unknown = Object.keys(payload).filter((key) => !(key in properties));
  if (unknown.length > 0 && schema.additionalProperties !== true) {
    throw usageError(
      `unknown argument${unknown.length === 1 ? "" : "s"} for ${tool.name}: ${unknown.map((key) => `--${key}`).join(", ")}`,
      `Run \`kanera help ${tool.name} --json\` to inspect the complete input schema.`,
    );
  }
  const missing = (schema.required ?? []).filter((key) => payload[key] === undefined);
  if (missing.length > 0) {
    throw usageError(
      `missing required argument${missing.length === 1 ? "" : "s"} for ${tool.name}: ${missing.map((key) => `--${key}`).join(", ")}`,
      `Run \`kanera help ${tool.name} --json\` to inspect the complete input schema.`,
    );
  }
  const shaped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    shaped[key] = coerceToSchema(value === true ? "true" : value, schema.properties?.[key], schema);
  }
  return shaped;
}
