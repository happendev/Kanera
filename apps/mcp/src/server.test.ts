import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { env } from "./env.js";
import { clearCardReferenceCache, createKaneraMcpServer } from "./server.js";

// Card key resolutions are cached per credential across calls; each test stubs its own upstream.
beforeEach(() => clearCardReferenceCache());

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

function toolHandler(name: string, apiKey = "kanera_live_test") {
  const server = createKaneraMcpServer({
    apiKey,
    publicApiUrl: "https://api.example.test",
  });
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
  const tool = tools[name];
  assert.ok(tool, `expected ${name} to be registered`);
  return tool.handler;
}

function parseToolText(result: CallToolResult) {
  const structured = result.structuredContent as Record<string, unknown> | undefined;
  if (structured && "result" in structured) return structured.result;
  if (structured) {
    const keys = Object.keys(structured);
    if (keys.length === 1 && "items" in structured) return structured.items;
    return structured;
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
      message: "workspaceId must identify a standard workspace; for a standalone board use boards.get_standalone_settings with its boardId",
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

void test("a resolved card key is reused across tool calls for the same credential only", async () => {
  const requests: string[] = [];
  await withFetchStub(async (input, init) => {
    const url = new URL(fetchInputUrl(input));
    requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/api/v1/search") {
      return new Response(JSON.stringify({ cards: [{ cardId: CARD_ID, cardKey: "DEV-9", organisationKey: ORGANISATION_KEY }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: CARD_ID, key: "DEV-9" }), { status: 200 });
  }, async () => {
    // Separate tool calls (separate server instances, as the stateless HTTP transport creates).
    await toolHandler("cards.get")({ cardId: "DEV-9" });
    await toolHandler("cards.get")({ cardId: "dev-9" });
    // Another credential must resolve for itself: a cached id is never shared across credentials.
    await toolHandler("cards.get", "kanera_live_other")({ cardId: "DEV-9" });
  });

  assert.deepEqual(requests, [
    "GET /api/v1/search",
    `GET /api/v1/cards/${CARD_ID}/detail`,
    `GET /api/v1/cards/${CARD_ID}/detail`,
    "GET /api/v1/search",
    `GET /api/v1/cards/${CARD_ID}/detail`,
  ]);
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
  assert.equal(payload.items.length, 12);
  const blank = payload.items.find((item) => item.id === "blank");
  assert.deepEqual(blank, {
    id: "blank",
    name: "Blank",
    description: "Start empty and add only the workflow and setup you need later.",
    icon: "layout-kanban",
    workspaceName: "Workspace",
    initialBoardName: "Board",
    lists: [],
    inProgressLists: [],
    customFields: [],
    labels: [],
    checklistTemplateCount: 0,
    starterCardCount: 0,
    automationCount: 0,
    automations: [],
  });
  const operations = payload.items.find((item) => item.id === "operations-support") as (typeof payload.items[number] & { inProgressLists: string[] }) | undefined;
  // Agents choosing a template can see which stages count as active work (time in progress).
  assert.deepEqual(operations?.inProgressLists, ["Assigned", "Escalated"]);
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

void test("cards.dependency_graph walks the focus card's chains and counts blockers that are not on the map", async () => {
  // done → upstream → focus → next → last; upstream also blocks sibling, which is neither side of
  // focus's chain. focus has one more open blocker on a board the caller cannot open.
  const id = (n: number) => `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${String(n).repeat(12)}`;
  const [done, upstream, next, last, sibling, related] = [4, 5, 6, 7, 8, 9].map(id);
  const card = (cardId: string, key: string, extra: Record<string, unknown> = {}) => ({
    id: cardId, key, title: key, url: `https://board.example.test/o/${ORGANISATION_KEY}/c/${key}`, boardId: BOARD_ID, listId: WORKSPACE_ID, inScope: true, ...extra,
  });
  let body: unknown;
  const result = await withFetchStub(async (_input, init) => {
    body = JSON.parse(init?.body as string);
    return new Response(JSON.stringify({
      cards: [
        card(done!, "API-1", { completedAt: "2026-10-01T00:00:00.000Z", inScope: false }),
        card(upstream!, "API-2"),
        card(CARD_ID, "API-3", { blockedByCount: 2, assigneeIds: [WORKSPACE_ID], labelIds: [BOARD_ID] }),
        card(next!, "API-4", { blockedByCount: 1 }),
        card(last!, "API-5", { blockedByCount: 1 }),
        card(sibling!, "API-6", { blockedByCount: 1 }),
        card(related!, "API-7"),
      ],
      edges: [
        { id: id(1), sourceCardId: done, targetCardId: upstream, kind: "blocks" },
        { id: id(2), sourceCardId: upstream, targetCardId: CARD_ID, kind: "blocks" },
        { id: id(3), sourceCardId: CARD_ID, targetCardId: next, kind: "blocks" },
        { id: id(4), sourceCardId: next, targetCardId: last, kind: "blocks" },
        { id: id(5), sourceCardId: upstream, targetCardId: sibling, kind: "blocks" },
        { id: id(6), sourceCardId: CARD_ID, targetCardId: related, kind: "relates_to" },
      ],
      boards: [{ id: BOARD_ID, name: "Platform", icon: null, iconColor: null }],
      lists: [{ id: WORKSPACE_ID, name: "Doing" }],
      labels: [{ id: BOARD_ID, name: "Risk", color: null }],
      people: [{ userId: WORKSPACE_ID, displayName: "Priya", avatarUrl: null }],
      truncated: false,
    }), { status: 200 });
  }, () => toolHandler("cards.dependency_graph")({ cardId: CARD_ID }));

  assert.deepEqual(body, { cardIds: [CARD_ID] });
  const output = parseToolText(result) as { focus: Record<string, unknown>; cards: Array<Record<string, unknown>> };
  assert.deepEqual(output.focus, {
    cardId: CARD_ID, onMap: true, blockedBy: [upstream], blocks: [next], upstream: [upstream, done], downstream: [next, last], relatedTo: [related],
  });
  const focus = output.cards.find((entry) => entry.id === CARD_ID)!;
  assert.equal(focus.openBlockerCount, 2);
  assert.equal(focus.offMapBlockerCount, 1, "the private blocker is counted, not shown");
  assert.deepEqual([focus.boardName, focus.listName, focus.labels, focus.assignees], ["Platform", "Doing", ["Risk"], [{ userId: WORKSPACE_ID, displayName: "Priya" }]]);
  // upstream's only blocker is completed, so nothing holds it up and nothing is off the map.
  const upstreamCard = output.cards.find((entry) => entry.id === upstream)!;
  assert.equal(upstreamCard.openBlockerCount, undefined);
  assert.equal(upstreamCard.offMapBlockerCount, undefined);
  assert.equal(output.cards.find((entry) => entry.id === sibling)!.offMapBlockerCount, undefined);
});

void test("cards.dependency_graph takes exactly one scope", async () => {
  for (const args of [{}, { boardId: BOARD_ID, workspaceId: WORKSPACE_ID }]) {
    const result = await withFetchStub(async () => {
      throw new Error("an invalid scope must not reach the API");
    }, () => toolHandler("cards.dependency_graph")(args));
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(parseToolText(result)), /exactly one of cardId, boardId or workspaceId/u);
  }
});

void test("cards.set_relations keeps going past a refused card and reports it beside the final relations", async () => {
  const other1 = "44444444-4444-4444-8444-444444444444";
  const other2 = "55555555-5555-4555-8555-555555555555";
  const posted: string[] = [];
  const result = await withFetchStub(async (input, init) => {
    const url = fetchInputUrl(input);
    if (init?.method === "POST") {
      const body = JSON.parse(init.body as string) as { targetCardId: string };
      posted.push(body.targetCardId);
      if (body.targetCardId === other1) {
        return new Response(JSON.stringify({ code: "RELATION_CYCLE", message: "would create a cycle" }), { status: 409 });
      }
      return new Response(JSON.stringify({ id: "r1" }), { status: 201 });
    }
    assert.match(url, /\/relations$/u);
    return new Response(JSON.stringify({ relations: [{ id: "r1", direction: "blocks", card: { id: other2 } }] }), { status: 200 });
  }, () => toolHandler("cards.set_relations")({ cardId: CARD_ID, direction: "blocks", otherCardIds: [other1, other2], remove: false }));

  // The refusal of the first card did not stop the second from being linked.
  assert.deepEqual(posted, [other1, other2]);
  assert.notEqual(result.isError, true);
  assert.deepEqual(parseToolText(result), {
    relations: [{ id: "r1", direction: "blocks", card: { id: other2 } }],
    failed: [{ cardId: other1, status: 409, code: "RELATION_CYCLE", message: "would create a cycle" }],
  });
});

void test("cards.set_relations reports committed adds by id when the final read is rate limited", async () => {
  const other1 = "44444444-4444-4444-8444-444444444444";
  const other2 = "55555555-5555-4555-8555-555555555555";
  const other3 = "66666666-6666-4666-8666-666666666666";
  const result = await withFetchStub(async (input, init) => {
    if (init?.method === "POST") {
      const body = JSON.parse(init.body as string) as { targetCardId: string };
      if (body.targetCardId === other1) return new Response(JSON.stringify({ id: "r1" }), { status: 201 });
      return new Response(JSON.stringify({ code: "RATE_LIMITED", message: "slow down" }), { status: 429 });
    }
    assert.match(fetchInputUrl(input), /\/relations$/u);
    return new Response(JSON.stringify({ code: "RATE_LIMITED", message: "slow down" }), { status: 429 });
  }, () => toolHandler("cards.set_relations")({ cardId: CARD_ID, direction: "blocks", otherCardIds: [other1, other2, other3], remove: false }));

  // The first add is committed; the 429 stopped the batch and then failed the read too. Neither
  // may hide what was linked.
  assert.notEqual(result.isError, true);
  assert.deepEqual(parseToolText(result), {
    addedCardIds: [other1],
    failed: [{ cardId: other2, status: 429, code: "RATE_LIMITED", message: "slow down" }],
    notAttemptedCardIds: [other3],
    relationsUnavailable: { status: 429, code: "RATE_LIMITED", message: "slow down" },
  });
});

void test("cards.set_relations is an error when no card could be linked", async () => {
  const other1 = "44444444-4444-4444-8444-444444444444";
  const result = await withFetchStub(
    async () => new Response(JSON.stringify({ error: { code: "FORBIDDEN", message: "forbidden" } }), { status: 403 }),
    () => toolHandler("cards.set_relations")({ cardId: CARD_ID, direction: "blocks", otherCardIds: [other1], remove: false }),
  );
  assert.equal(result.isError, true);
  assert.equal((parseToolText(result) as { error: { code: string } }).error.code, "FORBIDDEN");
});

// These exercise transport failures between independently committed removals. E2E cannot reliably
// arrange a rate-limit boundary or a concurrent deletion between requests without timing races.
void test("cards.set_relations reports removals committed before a batch rate limit", async () => {
  const otherIds = ["44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555", "66666666-6666-4666-8666-666666666666"];
  const relations = otherIds.map((id, index) => ({ id: `r${index}`, direction: "blocks", card: { id } }));
  const deleted: string[] = [];
  let reads = 0;
  const result = await withFetchStub(async (input, init) => {
    if (init?.method === "DELETE") {
      deleted.push(fetchInputUrl(input));
      if (deleted.length === 1) return new Response(null, { status: 204 });
    } else if (reads++ === 0) {
      return new Response(JSON.stringify({ relations, hiddenBlockerCount: 0 }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: "RATE_LIMITED", message: "slow down" }), { status: 429 });
  }, () => toolHandler("cards.set_relations")({ cardId: CARD_ID, direction: "blocks", otherCardIds: otherIds, remove: true }));

  assert.equal(deleted.length, 2, "the rate limit stops the remaining removals");
  assert.notEqual(result.isError, true);
  assert.deepEqual(parseToolText(result), {
    removedCardIds: [otherIds[0]],
    failed: [{ cardId: otherIds[1], status: 429, code: "RATE_LIMITED", message: "slow down" }],
    notAttemptedCardIds: [otherIds[2]],
    relationsUnavailable: { status: 429, code: "RATE_LIMITED", message: "slow down" },
  });
});

void test("cards.set_relations reports every committed removal when only the final read fails", async () => {
  const otherIds = ["44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"];
  let reads = 0;
  const result = await withFetchStub(async (_input, init) => {
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    if (reads++ === 0) return new Response(JSON.stringify({ relations: otherIds.map((id, index) => ({ id: `r${index}`, direction: "blocks", card: { id } })), hiddenBlockerCount: 0 }), { status: 200 });
    return new Response(JSON.stringify({ code: "UNAVAILABLE", message: "try later" }), { status: 503 });
  }, () => toolHandler("cards.set_relations")({ cardId: CARD_ID, direction: "blocks", otherCardIds: otherIds, remove: true }));

  assert.notEqual(result.isError, true);
  assert.deepEqual(parseToolText(result), { removedCardIds: otherIds, relationsUnavailable: { status: 503, code: "UNAVAILABLE", message: "try later" } });
});

void test("cards.set_relations preserves removals when the final response body is interrupted", async () => {
  const other = "44444444-4444-4444-8444-444444444444";
  let reads = 0;
  const result = await withFetchStub(async (_input, init) => {
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    if (reads++ === 0) return new Response(JSON.stringify({ relations: [{ id: "r1", direction: "blocks", card: { id: other } }], hiddenBlockerCount: 0 }), { status: 200 });
    return new Response(new ReadableStream({ pull(stream) { stream.error(new TypeError("socket terminated")); } }), { status: 200 });
  }, () => toolHandler("cards.set_relations")({ cardId: CARD_ID, direction: "blocks", otherCardIds: [other], remove: true }));

  assert.notEqual(result.isError, true);
  assert.deepEqual(parseToolText(result), {
    removedCardIds: [other],
    relationsUnavailable: { status: 503, code: "UPSTREAM_UNAVAILABLE", message: "Kanera is temporarily unavailable" },
  });
});

void test("cards.set_relations preserves earlier removals when a later delete response body is interrupted", async () => {
  const otherIds = ["44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555", "66666666-6666-4666-8666-666666666666"];
  const relations = otherIds.map((id, index) => ({ id: `r${index}`, direction: "blocks", card: { id } }));
  let reads = 0;
  let deletes = 0;
  const result = await withFetchStub(async (_input, init) => {
    if (init?.method === "DELETE") {
      if (deletes++ === 0) return new Response(null, { status: 204 });
      return new Response(new ReadableStream({ pull(stream) { stream.error(new TypeError("socket terminated")); } }), { status: 503 });
    }
    return new Response(JSON.stringify({ relations: reads++ === 0 ? relations : relations.slice(1), hiddenBlockerCount: 0 }), { status: 200 });
  }, () => toolHandler("cards.set_relations")({ cardId: CARD_ID, direction: "blocks", otherCardIds: otherIds, remove: true }));

  assert.equal(deletes, 2);
  assert.notEqual(result.isError, true);
  assert.deepEqual(parseToolText(result), {
    relations: relations.slice(1), hiddenBlockerCount: 0, removedCardIds: [otherIds[0]],
    failed: [{ cardId: otherIds[1], status: 503, code: "UPSTREAM_UNAVAILABLE", message: "Kanera is temporarily unavailable" }],
    notAttemptedCardIds: [otherIds[2]],
  });
});

void test("cards.set_relations continues after one removal is refused and reports both outcomes", async () => {
  const otherIds = ["44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"];
  const relations = otherIds.map((id, index) => ({ id: `r${index}`, direction: "blocks", card: { id } }));
  let reads = 0;
  const result = await withFetchStub(async (input, init) => {
    if (init?.method === "DELETE") return fetchInputUrl(input).endsWith("/r0")
      ? new Response(JSON.stringify({ code: "FORBIDDEN", message: "forbidden" }), { status: 403 })
      : new Response(null, { status: 204 });
    return new Response(JSON.stringify({ relations: reads++ === 0 ? relations : [relations[0]], hiddenBlockerCount: 0 }), { status: 200 });
  }, () => toolHandler("cards.set_relations")({ cardId: CARD_ID, direction: "blocks", otherCardIds: otherIds, remove: true }));

  assert.notEqual(result.isError, true);
  assert.deepEqual(parseToolText(result), {
    relations: [relations[0]], hiddenBlockerCount: 0, removedCardIds: [otherIds[1]],
    failed: [{ cardId: otherIds[0], status: 403, code: "FORBIDDEN", message: "forbidden" }],
  });
});

void test("cards.set_relations removes duplicate references once and preserves missing cards", async () => {
  const other = "44444444-4444-4444-8444-444444444444";
  const missing = "55555555-5555-4555-8555-555555555555";
  let deletes = 0;
  let reads = 0;
  const result = await withFetchStub(async (_input, init) => {
    if (init?.method === "DELETE") {
      deletes++;
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({ relations: reads++ === 0 ? [{ id: "r1", direction: "blocks", card: { id: other } }] : [], hiddenBlockerCount: 2 }), { status: 200 });
  }, () => toolHandler("cards.set_relations")({ cardId: CARD_ID, direction: "blocks", otherCardIds: [other, missing, other, missing], remove: true }));

  assert.equal(deletes, 1);
  assert.deepEqual(parseToolText(result), { relations: [], hiddenBlockerCount: 2, removedCardIds: [other], notFoundCardIds: [missing] });
});

void test("cards.set_relations treats already missing removals as a no-op", async () => {
  const other = "44444444-4444-4444-8444-444444444444";
  let requests = 0;
  const result = await withFetchStub(async (_input, init) => {
    requests++;
    assert.equal(init?.method, "GET");
    return new Response(JSON.stringify({ relations: [], hiddenBlockerCount: 1 }), { status: 200 });
  }, () => toolHandler("cards.set_relations")({ cardId: CARD_ID, direction: "blocks", otherCardIds: [other, other], remove: true }));

  assert.equal(requests, 1, "no writes need no follow-up read");
  assert.notEqual(result.isError, true);
  assert.deepEqual(parseToolText(result), { relations: [], hiddenBlockerCount: 1, notFoundCardIds: [other] });
});

void test("cards.set_relations treats a concurrently removed relation as already absent", async () => {
  const other = "44444444-4444-4444-8444-444444444444";
  let reads = 0;
  const result = await withFetchStub(async (_input, init) => {
    if (init?.method === "DELETE") return new Response(JSON.stringify({ code: "NOT_FOUND", message: "relation not found" }), { status: 404 });
    return new Response(JSON.stringify({ relations: reads++ === 0 ? [{ id: "r1", direction: "blocks", card: { id: other } }] : [], hiddenBlockerCount: 0 }), { status: 200 });
  }, () => toolHandler("cards.set_relations")({ cardId: CARD_ID, direction: "blocks", otherCardIds: [other], remove: true }));

  assert.notEqual(result.isError, true);
  assert.deepEqual(parseToolText(result), { relations: [], hiddenBlockerCount: 0, notFoundCardIds: [other] });
});

void test("cards.set_relations is an error when every attempted removal is refused", async () => {
  const other = "44444444-4444-4444-8444-444444444444";
  const result = await withFetchStub(async (_input, init) => init?.method === "DELETE"
    ? new Response(JSON.stringify({ code: "FORBIDDEN", message: "forbidden" }), { status: 403 })
    : new Response(JSON.stringify({ relations: [{ id: "r1", direction: "blocks", card: { id: other } }], hiddenBlockerCount: 0 }), { status: 200 }),
  () => toolHandler("cards.set_relations")({ cardId: CARD_ID, direction: "blocks", otherCardIds: [other], remove: true }));

  assert.equal(result.isError, true);
  assert.equal((parseToolText(result) as { error: { code: string } }).error.code, "FORBIDDEN");
});
