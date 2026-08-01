import assert from "node:assert/strict";
import test from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createKaneraMcpServer } from "./server.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const BOARD_ID = "22222222-2222-4222-8222-222222222222";
const CARD_ID = "33333333-3333-4333-8333-333333333333";
const ORGANISATION_KEY = "0123456789ABCDEF";

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

void test("kanera_get_board returns board detail without cards", async () => {
  const result = await withFetchStub(async () => new Response(JSON.stringify({
    board: { id: BOARD_ID, name: "Planning" },
    lists: [{ id: "33333333-3333-4333-8333-333333333333", name: "Backlog" }],
    cards: [{ id: "44444444-4444-4444-8444-444444444444", listId: "33333333-3333-4333-8333-333333333333" }],
    members: [],
  }), { status: 200 }), () => toolHandler("kanera_get_board")({ boardId: BOARD_ID }));

  assert.deepEqual(parseToolText(result), {
    board: { id: BOARD_ID, name: "Planning" },
    lists: [{ id: "33333333-3333-4333-8333-333333333333", name: "Backlog" }],
    members: [],
  });
});

void test("kanera_get_cards_list returns bounded pages from exactly one list", async () => {
  const backlogId = "33333333-3333-4333-8333-333333333333";
  const completedId = "44444444-4444-4444-8444-444444444444";
  let requestedUrl: string | null = null;
  const fetchBoard = async (input: Parameters<typeof fetch>[0]) => {
    requestedUrl = fetchInputUrl(input);
    const url = new URL(requestedUrl);
    const offset = Number(url.searchParams.get("cardOffset") ?? 0);
    const limit = Number(url.searchParams.get("cardLimit") ?? 25);
    const backlogCards = [
      { id: "55555555-5555-4555-8555-555555555555", listId: backlogId, title: "Next" },
      { id: "77777777-7777-4777-8777-777777777777", listId: backlogId, title: "Later" },
    ];
    return new Response(JSON.stringify({
      cards: backlogCards.slice(offset, offset + limit),
      cardPage: { offset, limit, hasMore: offset + limit < backlogCards.length },
      lists: [{ id: backlogId }, { id: completedId }],
    }), { status: 200 });
  };
  const firstResult = await withFetchStub(fetchBoard, () => toolHandler("kanera_get_cards_list")({
    boardId: BOARD_ID,
    listId: backlogId,
    limit: 1,
  }));

  assert.equal(requestedUrl, `https://api.example.test/api/v1/boards/${BOARD_ID}/open?includeCompleted=true&archived=false&listId=${backlogId}&cardLimit=1&cardOffset=0`);
  const firstPage = parseToolText(firstResult) as { cards: unknown[]; nextCursor: string | null };
  assert.deepEqual(firstPage.cards, [
    { id: "55555555-5555-4555-8555-555555555555", listId: backlogId, title: "Next" },
  ]);
  assert.equal(typeof firstPage.nextCursor, "string");

  const secondResult = await withFetchStub(fetchBoard, () => toolHandler("kanera_get_cards_list")({
    boardId: BOARD_ID,
    listId: backlogId,
    cursor: firstPage.nextCursor,
    limit: 1,
  }));
  assert.deepEqual(parseToolText(secondResult), {
    cards: [{ id: "77777777-7777-4777-8777-777777777777", listId: backlogId, title: "Later" }],
    nextCursor: null,
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

void test("card tools resolve a current human key before calling an id-based public API route", async () => {
  const requests: string[] = [];
  const result = await withFetchStub(async (input, init) => {
    const url = new URL(fetchInputUrl(input));
    requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    if (url.pathname === "/api/v1/search") {
      return new Response(JSON.stringify({
        cards: [{ cardId: CARD_ID, cardKey: "DEV-9", organisationKey: ORGANISATION_KEY }],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: CARD_ID, key: "DEV-9", title: "Updated" }), { status: 200 });
  }, () => toolHandler("kanera_update_card")({ cardId: "dev-9", title: "Updated" }));

  assert.deepEqual(requests, [
    "GET /api/v1/search?q=dev-9&limit=20",
    `PATCH /api/v1/cards/${CARD_ID}`,
  ]);
  assert.deepEqual(parseToolText(result), { id: CARD_ID, key: "DEV-9", title: "Updated" });
});

void test("card tools resolve a historical human key through its accessible organisation", async () => {
  const requests: string[] = [];
  const result = await withFetchStub(async (input, init) => {
    const url = new URL(fetchInputUrl(input));
    requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    if (url.pathname === "/api/v1/search") {
      return new Response(JSON.stringify({
        cards: [{ cardId: CARD_ID, cardKey: "OPS-9", organisationKey: ORGANISATION_KEY }],
      }), { status: 200 });
    }
    if (url.pathname === `/api/v1/organisations/${ORGANISATION_KEY}/cards/by-key/DEV-9`) {
      return new Response(JSON.stringify({ id: CARD_ID, key: "OPS-9" }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: CARD_ID, key: "OPS-9", completedAt: "2026-08-01T00:00:00.000Z" }), { status: 200 });
  }, () => toolHandler("kanera_set_card_completion")({ cardId: "DEV-9", completed: true }));

  assert.deepEqual(requests, [
    "GET /api/v1/search?q=DEV-9&limit=20",
    `GET /api/v1/organisations/${ORGANISATION_KEY}/cards/by-key/DEV-9`,
    `PATCH /api/v1/cards/${CARD_ID}/completion`,
  ]);
  assert.equal(result.isError, undefined);
});

void test("canonical card URLs disambiguate keys without global search", async () => {
  const requests: string[] = [];
  const result = await withFetchStub(async (input, init) => {
    const url = new URL(fetchInputUrl(input));
    requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === `/api/v1/organisations/${ORGANISATION_KEY}/cards/by-key/DEV-9`) {
      return new Response(JSON.stringify({ id: CARD_ID, key: "OPS-9" }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: CARD_ID, key: "OPS-9" }), { status: 200 });
  }, () => toolHandler("kanera_get_card")({
    cardId: `https://app.kanera.test/o/${ORGANISATION_KEY.toLowerCase()}/c/dev-9`,
  }));

  assert.deepEqual(requests, [
    `GET /api/v1/organisations/${ORGANISATION_KEY}/cards/by-key/DEV-9`,
    `GET /api/v1/cards/${CARD_ID}/detail`,
  ]);
  assert.equal(result.isError, undefined);
});

void test("plain card keys fail safely when accessible organisations make them ambiguous", async () => {
  const secondOrganisationKey = "FEDCBA9876543210";
  const result = await withFetchStub(async () => new Response(JSON.stringify({
    cards: [
      { cardId: CARD_ID, cardKey: "DEV-9", organisationKey: ORGANISATION_KEY },
      { cardId: "44444444-4444-4444-8444-444444444444", cardKey: "DEV-9", organisationKey: secondOrganisationKey },
    ],
  }), { status: 200 }), () => toolHandler("kanera_archive_card")({ cardId: "DEV-9", archived: true }));

  assert.equal(result.isError, true);
  assert.deepEqual(parseToolText(result), {
    error: {
      status: 400,
      code: "VALIDATION_ERROR",
      message: "card key DEV-9 is ambiguous across accessible organisations; use a canonical Kanera card URL or UUID",
    },
  });
});

void test("bulk card tools resolve repeated human keys once and preserve input order", async () => {
  let searchCalls = 0;
  let mutationBody: unknown;
  const result = await withFetchStub(async (input, init) => {
    const url = new URL(fetchInputUrl(input));
    if (url.pathname === "/api/v1/search") {
      searchCalls += 1;
      return new Response(JSON.stringify({
        cards: [{ cardId: CARD_ID, cardKey: "DEV-9", organisationKey: ORGANISATION_KEY }],
      }), { status: 200 });
    }
    const body = init?.body;
    if (typeof body !== "string") assert.fail("expected JSON request body");
    mutationBody = JSON.parse(body);
    return new Response(JSON.stringify({ updated: 2 }), { status: 200 });
  }, () => toolHandler("kanera_bulk_set_card_completion")({
    boardId: BOARD_ID,
    cardIds: ["DEV-9", "dev-9"],
    completed: true,
  }));

  assert.equal(searchCalls, 1);
  assert.deepEqual(mutationBody, { cardIds: [CARD_ID, CARD_ID], completed: true });
  assert.deepEqual(parseToolText(result), { updated: 2 });
});
