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

void test("standalone delete refuses to delete a standard workspace board", async () => {
  const methods: string[] = [];
  const result = await withFetchStub(async (input, init) => {
    const url = new URL(fetchInputUrl(input));
    methods.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === `/api/v1/boards/${BOARD_ID}`) {
      return new Response(JSON.stringify({ id: BOARD_ID, workspaceId: WORKSPACE_ID, name: "Board" }), { status: 200 });
    }
    return new Response(JSON.stringify({ workspace: { id: WORKSPACE_ID, kind: "standard", name: "Workspace" }, role: "admin" }), { status: 200 });
  }, () => toolHandler("kanera_delete_standalone_board")({ boardId: BOARD_ID }));

  assert.deepEqual(methods, [
    `GET /api/v1/boards/${BOARD_ID}`,
    `GET /api/v1/workspaces/${WORKSPACE_ID}`,
  ]);
  assert.equal(result.isError, true);
  assert.deepEqual(parseToolText(result), {
    error: {
      status: 400,
      code: "VALIDATION_ERROR",
      message: "board is not a standalone board",
    },
  });
});

void test("configuration tools require exactly one target before calling the public API", async () => {
  let fetchCalls = 0;
  const result = await withFetchStub(async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({}), { status: 200 });
  }, () => toolHandler("kanera_create_list")({ name: "Ready" }));

  assert.equal(fetchCalls, 0);
  assert.equal(result.isError, true);
  assert.deepEqual(parseToolText(result), {
    error: {
      status: 400,
      code: "VALIDATION_ERROR",
      message: "provide exactly one of workspaceId or standaloneBoardId",
    },
  });
});

void test("configuration tools reject two targets before calling the public API", async () => {
  let fetchCalls = 0;
  const result = await withFetchStub(async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({}), { status: 200 });
  }, () => toolHandler("kanera_create_label")({
    workspaceId: WORKSPACE_ID,
    standaloneBoardId: BOARD_ID,
    name: "Blocked",
  }));

  assert.equal(fetchCalls, 0);
  assert.equal(result.isError, true);
  assert.deepEqual(parseToolText(result), {
    error: {
      status: 400,
      code: "VALIDATION_ERROR",
      message: "provide exactly one of workspaceId or standaloneBoardId",
    },
  });
});

void test("standard workspace tools reject a standalone configuration id", async () => {
  const result = await withFetchStub(async () => new Response(JSON.stringify({
    workspace: { id: WORKSPACE_ID, kind: "board", name: "Solo" },
    role: "admin",
  }), { status: 200 }), () => toolHandler("kanera_get_workspace")({ workspaceId: WORKSPACE_ID }));

  assert.equal(result.isError, true);
  assert.deepEqual(parseToolText(result), {
    error: {
      status: 400,
      code: "VALIDATION_ERROR",
      message: "workspaceId must identify a standard workspace; use standaloneBoardId for a standalone board",
    },
  });
});

void test("workspace discovery never exposes a standalone backing workspace", async () => {
  const result = await withFetchStub(async () => new Response(JSON.stringify([
    { id: WORKSPACE_ID, kind: "standard", name: "Delivery" },
    { id: BOARD_ID, kind: "board", name: "Solo" },
  ]), { status: 200 }), () => toolHandler("kanera_list_workspaces")({ limit: 25 }));

  assert.deepEqual(parseToolText(result), [{ id: WORKSPACE_ID, kind: "standard", name: "Delivery" }]);
});

void test("target-aware list update refuses a list from another standalone board", async () => {
  const methods: string[] = [];
  const result = await withFetchStub(async (input, init) => {
    const url = new URL(fetchInputUrl(input));
    methods.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === `/api/v1/boards/${BOARD_ID}`) {
      return new Response(JSON.stringify({ id: BOARD_ID, workspaceId: WORKSPACE_ID, name: "Solo" }), { status: 200 });
    }
    return new Response(JSON.stringify({
      workspace: { id: WORKSPACE_ID, kind: "board", name: "Solo" },
      role: "admin",
      lists: [],
    }), { status: 200 });
  }, () => toolHandler("kanera_update_list")({
    standaloneBoardId: BOARD_ID,
    listId: "33333333-3333-4333-8333-333333333333",
    name: "Ready",
  }));

  assert.deepEqual(methods, [
    `GET /api/v1/boards/${BOARD_ID}`,
    `GET /api/v1/workspaces/${WORKSPACE_ID}`,
  ]);
  assert.equal(result.isError, true);
  assert.deepEqual(parseToolText(result), {
    error: {
      status: 400,
      code: "VALIDATION_ERROR",
      message: "list does not belong to the selected configuration target",
    },
  });
});
