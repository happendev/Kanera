import "../../api/src/test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { buildPublicApiServer } from "../../api/src/public-api-server.js";
import { buildIntegrationServer } from "../../api/src/test/integration.js";
import { createKaneraMcpServer } from "./server.js";

type RegisteredTool = {
  handler: (args: unknown) => Promise<CallToolResult>;
};

type SignupResponse = {
  accessToken: string;
  user: { id: string };
};

type WorkspaceResponse = {
  id: string;
};

type WorkspaceDetailResponse = {
  lists: { id: string }[];
};

type BoardResponse = {
  id: string;
};

type ApiKeyResponse = {
  secret: string;
};

function toolHandler(apiKey: string, publicApiUrl: string, name: string) {
  const server = createKaneraMcpServer({ apiKey, publicApiUrl });
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
  const tool = tools[name];
  assert.ok(tool, `expected ${name} to be registered`);
  return tool.handler;
}

function parseToolText<T>(result: CallToolResult): T {
  const item = result.content[0];
  assert.equal(item?.type, "text");
  return JSON.parse(item.text) as T;
}

function headersForInject(init?: RequestInit) {
  const headers = new Headers(init?.headers);
  return Object.fromEntries(headers.entries());
}

function responseHeaders(response: LightMyRequestResponse) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(response.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, String(item));
    } else if (value !== undefined) {
      headers.set(key, String(value));
    }
  }
  return headers;
}

function publicApiFetch(app: FastifyInstance): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const body = init?.body ?? (input instanceof Request ? await input.text() : undefined);
    const response = await app.inject({
      method,
      url: `${url.pathname}${url.search}`,
      headers: headersForInject(init),
      payload: typeof body === "string" ? body : undefined,
    });
    return new Response(response.body, {
      status: response.statusCode,
      headers: responseHeaders(response),
    });
  };
}

async function seedFixture() {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "MCP Integration Co",
      email: "mcp-integration@example.com",
      password: "Abc12345",
      displayName: "MCP Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken } = signup.json<SignupResponse>();

  const workspaceCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "MCP Workspace" },
  });
  assert.equal(workspaceCreated.statusCode, 201);
  const workspace = workspaceCreated.json<WorkspaceResponse>();

  const boardCreated = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/boards`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "MCP Board" },
  });
  assert.equal(boardCreated.statusCode, 201);
  const board = boardCreated.json<BoardResponse>();

  const workspaceDetail = await app.inject({
    method: "GET",
    url: `/workspaces/${workspace.id}`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(workspaceDetail.statusCode, 200);
  const [list] = workspaceDetail.json<WorkspaceDetailResponse>().lists;
  assert.ok(list);

  const writeKeyCreated = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/api-keys`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "MCP Write", scope: "write" },
  });
  assert.equal(writeKeyCreated.statusCode, 201);

  const readKeyCreated = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/api-keys`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "MCP Read", scope: "read" },
  });
  assert.equal(readKeyCreated.statusCode, 201);

  return {
    workspace,
    board,
    listId: list.id,
    writeKey: writeKeyCreated.json<ApiKeyResponse>().secret,
    readKey: readKeyCreated.json<ApiKeyResponse>().secret,
  };
}

async function withPublicApi<T>(callback: (publicApiUrl: string) => Promise<T>) {
  const publicApi = await buildPublicApiServer({
    enableWebhookDeliveryScheduler: false,
    logger: false,
    rateLimit: { enabled: false },
    uploadsDir: ".tmp/test-public-uploads",
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = publicApiFetch(publicApi);
  try {
    return await callback("https://public-api.example.test");
  } finally {
    globalThis.fetch = originalFetch;
    await publicApi.close();
  }
}

void test("MCP tools initialize against the real public API and create cards with API-key activity", async () => {
  const fixture = await seedFixture();

  await withPublicApi(async (publicApiUrl) => {
    const listWorkspaces = toolHandler(fixture.writeKey, publicApiUrl, "kanera_list_workspaces");
    const workspaces = parseToolText<{ id: string; name: string }[]>(await listWorkspaces({ limit: 10 }));
    assert.equal(workspaces.some((workspace) => workspace.id === fixture.workspace.id), true);

    const openBoard = toolHandler(fixture.writeKey, publicApiUrl, "kanera_open_board");
    const boardPayload = parseToolText<{ board: { id: string }; lists: { id: string }[] }>(await openBoard({ boardId: fixture.board.id }));
    assert.equal(boardPayload.board.id, fixture.board.id);
    assert.equal(boardPayload.lists.some((list) => list.id === fixture.listId), true);

    const createCard = toolHandler(fixture.writeKey, publicApiUrl, "kanera_create_card");
    const card = parseToolText<{ id: string; title: string }>(await createCard({
      boardId: fixture.board.id,
      listId: fixture.listId,
      title: "Created through MCP",
      description: "Created by an MCP integration test.",
    }));
    assert.equal(card.title, "Created through MCP");

    const getCard = toolHandler(fixture.writeKey, publicApiUrl, "kanera_get_card");
    const cardDetail = parseToolText<{ card: { id: string; title: string } }>(await getCard({ cardId: card.id }));
    assert.equal(cardDetail.card.title, "Created through MCP");

    const listActivity = toolHandler(fixture.writeKey, publicApiUrl, "kanera_list_activity");
    const activity = parseToolText<Array<{ type: string; data: { entityId?: string; action?: string; actorKind?: string; apiKeyName?: string } }>>(
      await listActivity({ boardId: fixture.board.id, limit: 20 }),
    );
    const createdActivity = activity.find((item) => item.type === "activity" && item.data.entityId === card.id && item.data.action === "created");
    assert.equal(createdActivity?.data.actorKind, "apiKey");
    assert.equal(createdActivity?.data.apiKeyName, "MCP Write");
  });
});

void test("MCP checklist tools drive the plan->track flow end to end", async () => {
  const fixture = await seedFixture();

  await withPublicApi(async (publicApiUrl) => {
    const createCard = toolHandler(fixture.writeKey, publicApiUrl, "kanera_create_card");
    const card = parseToolText<{ id: string }>(await createCard({
      boardId: fixture.board.id,
      listId: fixture.listId,
      title: "Plan and track through MCP",
    }));

    const createChecklist = toolHandler(fixture.writeKey, publicApiUrl, "kanera_create_checklist");
    const checklist = parseToolText<{ id: string; title: string }>(await createChecklist({ cardId: card.id, title: "Launch steps" }));
    assert.equal(checklist.title, "Launch steps");

    const addItem = toolHandler(fixture.writeKey, publicApiUrl, "kanera_add_checklist_item");
    const item = parseToolText<{ id: string; text: string; completedAt: string | null }>(
      await addItem({ cardId: card.id, checklistId: checklist.id, text: "Write the plan" }),
    );
    assert.equal(item.completedAt, null);

    // Flipping completed is the tracking half of the featured example; confirm it persists on the card detail.
    const updateItem = toolHandler(fixture.writeKey, publicApiUrl, "kanera_update_checklist_item");
    await updateItem({ cardId: card.id, checklistId: checklist.id, itemId: item.id, completed: true });

    const getCard = toolHandler(fixture.writeKey, publicApiUrl, "kanera_get_card");
    const detail = parseToolText<{ checklists: Array<{ id: string; items: Array<{ id: string; completedAt: string | null }> }> }>(
      await getCard({ cardId: card.id }),
    );
    const trackedItem = detail.checklists.find((c) => c.id === checklist.id)?.items.find((i) => i.id === item.id);
    assert.ok(trackedItem, "expected the checklist item to be present on the card detail");
    assert.notEqual(trackedItem.completedAt, null);
  });
});

void test("MCP duplicate and comment tools round-trip against the real public API", async () => {
  const fixture = await seedFixture();

  await withPublicApi(async (publicApiUrl) => {
    const createCard = toolHandler(fixture.writeKey, publicApiUrl, "kanera_create_card");
    const card = parseToolText<{ id: string }>(await createCard({
      boardId: fixture.board.id,
      listId: fixture.listId,
      title: "Original card",
    }));

    // Duplicate returns a distinct card so the agent can keep working with the copy.
    const duplicate = toolHandler(fixture.writeKey, publicApiUrl, "kanera_duplicate_card");
    const copy = parseToolText<{ id: string }>(await duplicate({ cardId: card.id }));
    assert.notEqual(copy.id, card.id);

    // add_comment then list_card_comments proves the read/write pair is symmetric via MCP.
    const addComment = toolHandler(fixture.writeKey, publicApiUrl, "kanera_add_comment");
    await addComment({ cardId: card.id, body: "First note from the agent" });

    const listComments = toolHandler(fixture.writeKey, publicApiUrl, "kanera_list_card_comments");
    const page = parseToolText<{ items: Array<{ body: string }> }>(await listComments({ cardId: card.id }));
    assert.equal(page.items.some((comment) => comment.body === "First note from the agent"), true);
  });
});

void test("MCP tools surface public API scope failures as structured tool errors", async () => {
  const fixture = await seedFixture();

  await withPublicApi(async (publicApiUrl) => {
    const listWorkspaces = toolHandler(fixture.readKey, publicApiUrl, "kanera_list_workspaces");
    const workspaces = parseToolText<{ id: string }[]>(await listWorkspaces({ limit: 10 }));
    assert.equal(workspaces.some((workspace) => workspace.id === fixture.workspace.id), true);

    const createCard = toolHandler(fixture.readKey, publicApiUrl, "kanera_create_card");
    const result = parseToolText<{ error: { status: number; code: string; message: string } }>(await createCard({
      boardId: fixture.board.id,
      listId: fixture.listId,
      title: "Read key should fail",
    }));

    assert.equal(result.error.status, 403);
    assert.equal(result.error.code, "FORBIDDEN");
  });
});
