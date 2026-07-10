import assert from "node:assert/strict";
import test from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createKaneraMcpServer } from "./server.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const BOARD_ID = "22222222-2222-4222-8222-222222222222";

type RegisteredTool = {
  handler: (args: unknown) => Promise<CallToolResult>;
};

function fetchInputUrl(input: Parameters<typeof fetch>[0]) {
  if (input instanceof URL) return input.toString();
  if (input instanceof Request) return input.url;
  return input;
}

function toolHandler(name: string) {
  const server = createKaneraMcpServer({
    apiKey: "kanera_live_test",
    publicApiUrl: "https://api.example.test",
  });
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
  const tool = tools[name];
  assert.ok(tool, `expected ${name} to be registered`);
  return tool.handler;
}

function parseToolText(result: CallToolResult) {
  const item = result.content[0];
  assert.equal(item?.type, "text");
  return JSON.parse(item.text) as unknown;
}

async function withFetchStub<T>(fetchImpl: typeof fetch, callback: () => Promise<T>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

void test("kanera_list_notes rejects missing target before calling the public API", async () => {
  let fetchCalls = 0;
  const result = await withFetchStub(async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify([]), { status: 200 });
  }, () => toolHandler("kanera_list_notes")({ scope: "team" }));

  assert.equal(fetchCalls, 0);
  assert.equal(result.isError, true);
  assert.deepEqual(parseToolText(result), {
    error: {
      status: 400,
      code: "VALIDATION_ERROR",
      message: "provide exactly one of workspaceId or boardId",
    },
  });
});

void test("kanera_list_notes rejects ambiguous target before calling the public API", async () => {
  let fetchCalls = 0;
  const result = await withFetchStub(async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify([]), { status: 200 });
  }, () => toolHandler("kanera_list_notes")({ workspaceId: WORKSPACE_ID, boardId: BOARD_ID, scope: "team" }));

  assert.equal(fetchCalls, 0);
  assert.equal(result.isError, true);
  assert.deepEqual(parseToolText(result), {
    error: {
      status: 400,
      code: "VALIDATION_ERROR",
      message: "provide exactly one of workspaceId or boardId",
    },
  });
});

void test("kanera_list_notes calls the workspace notes public API path", async () => {
  let requestedUrl: string | null = null;
  const result = await withFetchStub(async (input) => {
    requestedUrl = fetchInputUrl(input);
    return new Response(JSON.stringify([{ id: "note-1" }]), { status: 200 });
  }, () => toolHandler("kanera_list_notes")({ workspaceId: WORKSPACE_ID, scope: "team" }));

  assert.equal(requestedUrl, `https://api.example.test/api/v1/workspaces/${WORKSPACE_ID}/notes?scope=team`);
  assert.deepEqual(parseToolText(result), [{ id: "note-1" }]);
});

void test("kanera_list_notes calls the board notes public API path", async () => {
  let requestedUrl: string | null = null;
  const result = await withFetchStub(async (input) => {
    requestedUrl = fetchInputUrl(input);
    return new Response(JSON.stringify([{ id: "note-2" }]), { status: 200 });
  }, () => toolHandler("kanera_list_notes")({ boardId: BOARD_ID, scope: "personal" }));

  assert.equal(requestedUrl, `https://api.example.test/api/v1/boards/${BOARD_ID}/notes?scope=personal`);
  assert.deepEqual(parseToolText(result), [{ id: "note-2" }]);
});
