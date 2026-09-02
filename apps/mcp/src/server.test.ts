import assert from "node:assert/strict";
import test from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { env } from "./env.js";
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
  if (result.structuredContent && "result" in result.structuredContent) return result.structuredContent.result;
  if (result.structuredContent) {
    const keys = Object.keys(result.structuredContent);
    if (keys.length === 1 && "items" in result.structuredContent) return result.structuredContent.items;
    return result.structuredContent;
  }
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

void test("oversized tool results fail with a bounded corrective error", async () => {
  const previousLimit = env.MCP_TOOL_OUTPUT_MAX_BYTES;
  env.MCP_TOOL_OUTPUT_MAX_BYTES = 16;
  try {
    const result = await withFetchStub(
      async () => new Response(JSON.stringify({ value: "x".repeat(100) }), { status: 200 }),
      () => toolHandler("session.get")({}),
    );
    assert.equal(result.isError, true);
    assert.deepEqual(parseToolText(result), {
      error: {
        status: 413,
        code: "RESPONSE_TOO_LARGE",
        message: "Kanera returned too much data for one MCP response; narrow the query or request a smaller page",
      },
    });
  } finally {
    env.MCP_TOOL_OUTPUT_MAX_BYTES = previousLimit;
  }
});

void test("notes.list rejects missing target before calling the public API", async () => {
  let fetchCalls = 0;
  const result = await withFetchStub(async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify([]), { status: 200 });
  }, () => toolHandler("notes.list")({ scope: "team" }));

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

void test("notes.list rejects ambiguous target before calling the public API", async () => {
  let fetchCalls = 0;
  const result = await withFetchStub(async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify([]), { status: 200 });
  }, () => toolHandler("notes.list")({ workspaceId: WORKSPACE_ID, boardId: BOARD_ID, scope: "team" }));

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

void test("notes.list calls the workspace notes public API path", async () => {
  let requestedUrl: string | null = null;
  const result = await withFetchStub(async (input) => {
    requestedUrl = fetchInputUrl(input);
    return new Response(JSON.stringify([{ id: "note-1" }]), { status: 200 });
  }, () => toolHandler("notes.list")({ workspaceId: WORKSPACE_ID, scope: "team" }));

  assert.equal(requestedUrl, `https://api.example.test/api/v1/workspaces/${WORKSPACE_ID}/notes?scope=team&limit=26&offset=0`);
  assert.deepEqual(parseToolText(result), { items: [{ id: "note-1" }], nextCursor: null });
});

void test("notes.list calls the board notes public API path", async () => {
  let requestedUrl: string | null = null;
  const result = await withFetchStub(async (input) => {
    requestedUrl = fetchInputUrl(input);
    return new Response(JSON.stringify([{ id: "note-2" }]), { status: 200 });
  }, () => toolHandler("notes.list")({ boardId: BOARD_ID, scope: "personal" }));

  assert.equal(requestedUrl, `https://api.example.test/api/v1/boards/${BOARD_ID}/notes?scope=personal&limit=26&offset=0`);
  assert.deepEqual(parseToolText(result), { items: [{ id: "note-2" }], nextCursor: null });
});

void test("directory cursors page results and reject cross-query reuse", async () => {
  const handler = toolHandler("notes.list");
  const result = await withFetchStub(async (input) => {
    const url = new URL(fetchInputUrl(input));
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 25);
    return new Response(JSON.stringify([
      { id: "note-1", content: "large body one" },
      { id: "note-2", content: "large body two" },
    ].slice(offset, offset + limit)), { status: 200 });
  }, async () => {
    const first = parseToolText(await handler({ workspaceId: WORKSPACE_ID, scope: "team", limit: 1 })) as {
      items: Array<Record<string, unknown>>;
      nextCursor: string;
    };
    assert.deepEqual(first.items, [{ id: "note-1" }]);
    const second = parseToolText(await handler({ workspaceId: WORKSPACE_ID, scope: "team", limit: 1, cursor: first.nextCursor }));
    const mismatch = await handler({ boardId: BOARD_ID, scope: "team", limit: 1, cursor: first.nextCursor });
    return { second, mismatch };
  });

  assert.deepEqual(result.second, { items: [{ id: "note-2" }], nextCursor: null });
  assert.equal(result.mismatch.isError, true);
  assert.deepEqual(parseToolText(result.mismatch), {
    error: {
      status: 400,
      code: "VALIDATION_ERROR",
      message: "collection cursor does not match this query",
    },
  });
});

void test("boards.get returns board detail without cards", async () => {
  const result = await withFetchStub(async () => new Response(JSON.stringify({
    board: { id: BOARD_ID, name: "Planning" },
    lists: [{ id: "33333333-3333-4333-8333-333333333333", name: "Backlog" }],
    cards: [{ id: "44444444-4444-4444-8444-444444444444", listId: "33333333-3333-4333-8333-333333333333" }],
    members: [],
  }), { status: 200 }), () => toolHandler("boards.get")({ boardId: BOARD_ID }));

  assert.deepEqual(parseToolText(result), {
    board: { id: BOARD_ID, name: "Planning" },
    lists: [{ id: "33333333-3333-4333-8333-333333333333", name: "Backlog" }],
    members: [],
  });
});

void test("cards.list returns bounded pages from exactly one list", async () => {
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
  const firstResult = await withFetchStub(fetchBoard, () => toolHandler("cards.list")({
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

  const secondResult = await withFetchStub(fetchBoard, () => toolHandler("cards.list")({
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

void test("standard workspace tools reject a standalone configuration id", async () => {
  const result = await withFetchStub(async () => new Response(JSON.stringify({
    workspace: { id: WORKSPACE_ID, kind: "board", name: "Solo" },
    role: "admin",
  }), { status: 200 }), () => toolHandler("workspaces.get")({ workspaceId: WORKSPACE_ID }));

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
  ]), { status: 200 }), () => toolHandler("workspaces.list")({ limit: 25 }));

  assert.deepEqual(parseToolText(result), {
    items: [{ id: WORKSPACE_ID, kind: "standard", name: "Delivery" }],
    nextCursor: null,
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
  }, () => toolHandler("cards.update")({ cardId: "dev-9", changes: { title: "Updated" } }));

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
  }, () => toolHandler("cards.set_completion")({ cardId: "DEV-9", completed: true }));

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
  }, () => toolHandler("cards.get")({
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
  }), { status: 200 }), () => toolHandler("cards.archive")({ cardId: "DEV-9", archived: true }));

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
  }, () => toolHandler("cards.bulk_set_completion")({
    boardId: BOARD_ID,
    cardIds: ["DEV-9", "dev-9"],
    completed: true,
  }));

  assert.equal(searchCalls, 1);
  assert.deepEqual(mutationBody, { cardIds: [CARD_ID, CARD_ID], completed: true });
  assert.deepEqual(parseToolText(result), { updated: 2 });
});

void test("workspaces.list_templates answers from bundled templates without calling the public API", async () => {
  let fetchCalls = 0;
  const result = await withFetchStub(async () => {
    fetchCalls += 1;
    return new Response("{}", { status: 200 });
  }, () => toolHandler("workspaces.list_templates")({}));

  assert.equal(fetchCalls, 0);
  const payload = parseToolText(result) as { defaultTemplateId: string; items: Array<{ id: string; lists: string[]; customFields: unknown[]; labels: string[]; starterCardCount: number; automations: string[] }> };
  assert.equal(payload.defaultTemplateId, "development-team");
  assert.equal(payload.items.length, 11);
  const blank = payload.items.find((item) => item.id === "blank");
  assert.deepEqual(blank, {
    id: "blank",
    name: "Blank",
    description: "Start empty and add only the workflow and setup you need later.",
    icon: "layout-kanban",
    workspaceName: "Workspace",
    initialBoardName: "Board",
    lists: [],
    customFields: [],
    labels: [],
    checklistTemplateCount: 0,
    starterCardCount: 0,
    automationCount: 0,
    automations: [],
  });
  const operations = payload.items.find((item) => item.id === "operations-support");
  assert.deepEqual(operations?.automations, [
    "When a card's due date arrives: move to Escalated; set Escalated to checked if empty",
    "When a card enters Resolved: mark complete",
    "When a card enters Closed: mark complete",
  ]);
});

void test("workspaces.create narrows template seed content to the lists the caller kept", async () => {
  let body: Record<string, unknown> | undefined;
  const result = await withFetchStub(async (_input, init) => {
    body = JSON.parse(init?.body as string) as Record<string, unknown>;
    return new Response(JSON.stringify({ id: WORKSPACE_ID, kind: "standard", initialBoard: { id: BOARD_ID } }), { status: 201 });
  }, () => toolHandler("workspaces.create")({
    name: "Delivery",
    templateId: "project-delivery",
    // Drop the template's Review/Blocked/Done lanes: cards and automations that depend on them must vanish.
    lists: [{ name: "Planned" }, { name: "Backlog" }],
  }));

  assert.ok(body);
  assert.equal(body.kind, "standard");
  assert.deepEqual(body.lists, [{ name: "Planned" }, { name: "Backlog" }]);
  // Explicit lists replace the template's, but the untouched template fields and labels remain.
  assert.ok((body.customFields as unknown[]).length > 0);
  assert.ok((body.labels as unknown[]).length > 0);
  const cards = body.cards as Array<{ listName: string }>;
  assert.equal(cards.length, 3, "starter cards survive only for lists that were kept");
  assert.ok(cards.every((card) => ["planned", "backlog"].includes(card.listName.toLowerCase())));
  const automations = body.automations as Array<{ trigger: { type: string; listName?: string }; actions: Array<{ type: string; listName?: string }> }>;
  assert.equal(automations.length, 0, "every template rule depended on a removed lane");
  // Starter cards need a board, so the template's board is supplied when the caller omits one.
  assert.deepEqual(body.initialBoard, { name: "Delivery Plan", icon: "clipboard-check" });
  assert.deepEqual(parseToolText(result), { id: WORKSPACE_ID, kind: "standard", initialBoard: { id: BOARD_ID }, templateId: "project-delivery" });
});

void test("workspaces.create rejects a single list before calling the public API", async () => {
  let fetchCalls = 0;
  const result = await withFetchStub(async () => {
    fetchCalls += 1;
    return new Response("{}", { status: 200 });
  }, () => toolHandler("workspaces.create")({ name: "Solo", lists: [{ name: "Only" }] }));

  assert.equal(fetchCalls, 0);
  assert.equal(result.isError, true);
  assert.deepEqual(parseToolText(result), {
    error: { status: 400, code: "VALIDATION_ERROR", message: "lists must be empty or contain at least 2 items" },
  });
});

void test("workspace bootstrap tools explain the organisation-admin credential requirement on 403", async () => {
  const result = await withFetchStub(
    async () => new Response(JSON.stringify({ error: { code: "FORBIDDEN", message: "forbidden" } }), { status: 403 }),
    () => toolHandler("boards.create_standalone")({ name: "Reading list", templateId: "simple-todo" }),
  );

  assert.equal(result.isError, true);
  const payload = parseToolText(result) as { error: { status: number; code: string; message: string } };
  assert.equal(payload.error.status, 403);
  assert.equal(payload.error.code, "FORBIDDEN");
  assert.match(payload.error.message, /personal API key or interactive OAuth grant/);
  assert.match(payload.error.message, /session.get/);
});

void test("boards.create_standalone returns the visible board and its hidden workspace id", async () => {
  let body: Record<string, unknown> | undefined;
  const result = await withFetchStub(async (_input, init) => {
    body = JSON.parse(init?.body as string) as Record<string, unknown>;
    return new Response(JSON.stringify({
      id: WORKSPACE_ID,
      kind: "board",
      cardKeyPrefix: "READ",
      initialBoard: { id: BOARD_ID, name: "Reading list" },
    }), { status: 201 });
  }, () => toolHandler("boards.create_standalone")({ name: "Reading list", templateId: "simple-todo", seedStarterCards: false }));

  assert.ok(body);
  assert.equal(body.kind, "board");
  assert.deepEqual(body.initialBoard, { name: "Reading list", icon: "list-check" });
  assert.deepEqual(body.cards, []);
  assert.deepEqual(parseToolText(result), {
    board: { id: BOARD_ID, name: "Reading list" },
    workspaceId: WORKSPACE_ID,
    cardKeyPrefix: "READ",
    templateId: "simple-todo",
  });
});

void test("boards.create refuses a standalone backing workspace without writing", async () => {
  const requests: string[] = [];
  const result = await withFetchStub(async (input, init) => {
    requests.push(`${init?.method ?? "GET"} ${fetchInputUrl(input)}`);
    return new Response(JSON.stringify({ workspace: { id: WORKSPACE_ID, kind: "board", name: "Solo" }, role: "admin" }), { status: 200 });
  }, () => toolHandler("boards.create")({ workspaceId: WORKSPACE_ID, name: "Second" }));

  assert.deepEqual(requests, [`GET https://api.example.test/api/v1/workspaces/${WORKSPACE_ID}`]);
  assert.equal(result.isError, true);
  const payload = parseToolText(result) as { error: { code: string; message: string } };
  assert.equal(payload.error.code, "VALIDATION_ERROR");
  assert.match(payload.error.message, /boards.create_standalone/);
});
