import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client, ProtocolError, StreamableHTTPClientTransport, type Transport, type VersionNegotiationOptions } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import ports from "./ports.json";
import { expect, test } from "./support/fixtures";
import { boardIdOf, cardTile, createWorkspaceApiKey, expectCardTileMounted, openBoard, workspaceSettingsHref } from "./support/ui";

const mcpUrl = `http://localhost:${ports.mcp}/mcp`;
const publicApiOrigin = `http://localhost:${ports.publicApi}`;
// The bundled executable npm ships (built by scripts/test-e2e.sh), not the TypeScript sources.
const cli = path.join(__dirname, "..", "apps", "cli", "dist", "kanera.mjs");

type Era = "modern" | "legacy";
// `pin` makes the client fail loudly unless the server offers 2026-07-28; `legacy` is the plain
// 2025 initialize handshake with no probe, exactly what Claude, Codex and Cursor send today.
const negotiation: Record<Era, VersionNegotiationOptions> = {
  modern: { mode: { pin: "2026-07-28" } },
  legacy: { mode: "legacy" },
};

function httpTransport(apiKey: string): Transport {
  return new StreamableHTTPClientTransport(new URL(mcpUrl), {
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${apiKey}`);
      return fetch(input, { ...init, headers });
    },
  });
}

/** `kanera mcp` as an MCP host launches it: an in-process server over stdio, credential from the environment. */
function stdioTransport(apiKey: string, configHome: string): Transport {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  delete env.KANERA_PROFILE;
  delete env.KANERA_MCP_URL;
  env.KANERA_API_KEY = apiKey;
  env.KANERA_PUBLIC_API_URL = publicApiOrigin;
  env.XDG_CONFIG_HOME = configHome;
  return new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], env, stderr: "pipe" });
}

type Evidence = Record<string, unknown>;

/**
 * The same host-visible surface for every transport and era: discovery, a read, a write, resources,
 * prompts, cancellation and the three error shapes an agent branches on. The write's title is
 * unique per cell so the browser check at the end proves which cells reached the board.
 */
async function exercise(client: Client, cell: string, target: { boardId: string; listId: string; title: string }, evidence: Evidence[]) {
  const record = (step: string, detail: unknown) => evidence.push({ cell, step, detail });
  record("negotiated", { protocolVersion: client.getNegotiatedProtocolVersion(), capabilities: client.getServerCapabilities() });
  expect(client.getServerCapabilities()?.tools, cell).toBeTruthy();

  const tools = await client.listTools();
  const toolNames = tools.tools.map((tool) => tool.name);
  expect(toolNames, cell).toEqual(expect.arrayContaining(["boards.get", "cards.create", "cards.list", "session.get"]));
  // Tool schemas stay pinned to draft-07 (nullable fields as anyOf) across the SDK upgrade, so no
  // client sees a different contract than the v1 SDK published.
  const cardsCreate = tools.tools.find((tool) => tool.name === "cards.create")!;
  expect(JSON.stringify(cardsCreate.inputSchema), cell).not.toContain('"type":["');
  record("tools/list", { count: toolNames.length });

  const board = await client.callTool({ name: "boards.get", arguments: { boardId: target.boardId } });
  expect(board.isError, cell).not.toBe(true);
  const detail = board.structuredContent as { board: { id: string }; lists: Array<{ id: string }> };
  expect(detail.board.id, cell).toBe(target.boardId);
  expect(detail.lists.some((list) => list.id === target.listId), cell).toBe(true);

  const created = await client.callTool({ name: "cards.create", arguments: { boardId: target.boardId, listId: target.listId, title: target.title } });
  expect(created.isError, cell).not.toBe(true);
  record("cards.create", { id: (created.structuredContent as { id?: string } | undefined)?.id });

  const templates = await client.listResourceTemplates();
  expect(templates.resourceTemplates.map((template) => template.name).sort(), cell).toEqual(["board", "card", "note", "workspace"]);
  const resource = await client.readResource({ uri: `kanera://board/${target.boardId}` });
  const resourceBody = JSON.parse((resource.contents[0] as { text: string }).text) as { board: { id: string }; cards?: unknown };
  expect(resourceBody.board.id, cell).toBe(target.boardId);
  expect(resourceBody.cards, `${cell}: the board resource stays metadata-only`).toBeUndefined();

  const prompts = await client.listPrompts();
  expect(prompts.prompts.map((prompt) => prompt.name).sort(), cell).toEqual(["draft_card_from_notes", "prepare_one_on_one", "prepare_standup_update", "summarize_board_status"]);
  const prompt = await client.getPrompt({ name: "summarize_board_status", arguments: { boardId: target.boardId } });
  expect((prompt.messages[0]!.content as { text: string }).text, cell).toContain(target.boardId);

  // Cancellation: aborting an in-flight request rejects it locally and sends notifications/cancelled;
  // the session must stay usable afterwards.
  const controller = new AbortController();
  const cancelled = client.callTool({ name: "cards.list", arguments: { boardId: target.boardId, listId: target.listId } }, { signal: controller.signal });
  controller.abort(new Error("host cancelled"));
  await expect(cancelled, cell).rejects.toThrow();
  expect((await client.listTools()).tools.length, `${cell}: session survives a cancellation`).toBe(toolNames.length);
  record("cancel", "rejected locally, session reused");

  // Errors an agent must tell apart. Bad arguments come back as a tool result flagged isError (the
  // 2025-06-18+ rule the v2 SDK enforces), an unknown tool is a protocol error, and a domain failure
  // is a tool result carrying the API's problem document.
  const invalid = await client.callTool({ name: "cards.create", arguments: { boardId: target.boardId } });
  expect(invalid.isError, cell).toBe(true);
  expect((invalid.content[0] as { text: string }).text, `${cell}: missing listId names the field`).toMatch(/listId/u);
  const unknown = await client.callTool({ name: "cards.no_such_tool", arguments: {} }).then(() => null, (error: unknown) => error);
  expect(unknown, cell).toBeInstanceOf(ProtocolError);
  expect((unknown as ProtocolError).code, cell).toBe(-32602);
  const missing = await client.callTool({ name: "boards.get", arguments: { boardId: randomUUID() } });
  expect(missing.isError, cell).toBe(true);
  const problem = JSON.parse((missing.content[0] as { text: string }).text) as { error: { status: number; code: string } };
  expect(problem.error.status, cell).toBe(404);
  record("errors", { invalidArguments: (invalid.content[0] as { text: string }).text, unknownTool: (unknown as ProtocolError).code, notFound: problem.error });
}

test("both protocol eras work over HTTP and stdio: discovery, reads, writes, resources, prompts, cancellation and errors", async ({ page, signIn, uniqueName }, testInfo) => {
  await signIn(page, "amelia");
  const boardId = await boardIdOf(page, "Platform Delivery");
  const settings = await workspaceSettingsHref(page, "Platform Delivery");
  const apiKey = await createWorkspaceApiKey(page, settings, uniqueName("MCP protocol key"));

  // The board stays open for the whole matrix, so each cell's write must arrive live.
  await openBoard(page, "Platform Delivery");
  const probe = new Client({ name: "kanera-e2e-probe", version: "1" }, { versionNegotiation: negotiation.legacy });
  await probe.connect(httpTransport(apiKey));
  const opened = await probe.callTool({ name: "boards.get", arguments: { boardId } });
  const listId = (opened.structuredContent as { lists: Array<{ id: string }> }).lists[0]!.id;
  await probe.close();

  const configHome = mkdtempSync(path.join(tmpdir(), "kanera-mcp-protocol-e2e-"));
  const evidence: Evidence[] = [];
  const titles: Array<[string, string]> = [];
  try {
    for (const transport of ["http", "stdio"] as const) {
      for (const era of ["modern", "legacy"] as const) {
        const cell = `${transport}/${era}`;
        const title = uniqueName(`MCP ${cell} card`);
        titles.push([cell, title]);
        const client = new Client({ name: `kanera-e2e-${cell}`, version: "1" }, { versionNegotiation: negotiation[era] });
        await client.connect(transport === "http" ? httpTransport(apiKey) : stdioTransport(apiKey, configHome));
        try {
          if (era === "modern") expect(client.getNegotiatedProtocolVersion(), cell).toBe("2026-07-28");
          else expect(client.getNegotiatedProtocolVersion(), cell).not.toBe("2026-07-28");
          await exercise(client, cell, { boardId, listId, title }, evidence);
        } finally {
          await client.close();
        }
      }
    }
    for (const [cell, title] of titles) {
      // Mounts the tile first: late cells append past the lane's render window in a full-suite run.
      await expectCardTileMounted(page, title);
      await expect(cardTile(page, title), `${cell} write reached the open board`).toBeVisible();
    }
  } finally {
    // Protocol evidence per cell; the API key never enters the artifact.
    await testInfo.attach("mcp-protocol-matrix.json", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
    rmSync(configHome, { recursive: true, force: true });
  }
});
