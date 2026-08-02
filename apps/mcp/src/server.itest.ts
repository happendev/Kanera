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

type RegisteredResource = {
  readCallback: (uri: URL, vars: Record<string, string>) => Promise<{ contents: Array<{ text?: string }> }>;
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

function resourceHandler(apiKey: string, publicApiUrl: string, name: string) {
  const server = createKaneraMcpServer({ apiKey, publicApiUrl });
  const resources = (server as unknown as { _registeredResourceTemplates: Record<string, RegisteredResource> })._registeredResourceTemplates;
  const resource = resources[name];
  assert.ok(resource, `expected ${name} resource to be registered`);
  return resource.readCallback;
}

function parseToolText<T>(result: CallToolResult): T {
  if (result.structuredContent && "result" in result.structuredContent) return result.structuredContent.result as T;
  const item = result.content[0];
  assert.equal(item?.type, "text");
  return JSON.parse(item.text) as T;
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
    // Materializing a Request lets undici add the multipart boundary for FormData uploads. Passing
    // the resulting bytes to Fastify keeps this in-process bridge faithful to a real HTTP request.
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const method = request.method;
    const payload = method === "GET" || method === "HEAD"
      ? undefined
      : Buffer.from(await request.arrayBuffer());
    const response = await app.inject({
      method,
      url: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(request.headers.entries()),
      payload,
    });
    return new Response(response.statusCode === 204 ? null : response.body, {
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
  const { accessToken, user } = signup.json<SignupResponse>();

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

  const personalKeyCreated = await app.inject({
    method: "POST",
    url: "/me/api-keys",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { label: "MCP Personal" },
  });
  assert.equal(personalKeyCreated.statusCode, 201);

  return {
    workspace,
    board,
    userId: user.id,
    listId: list.id,
    writeKey: writeKeyCreated.json<ApiKeyResponse>().secret,
    readKey: readKeyCreated.json<ApiKeyResponse>().secret,
    personalKey: personalKeyCreated.json<ApiKeyResponse>().secret,
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
    const workspaces = parseToolText<{ items: Array<{ id: string; name: string }> }>(await listWorkspaces({ limit: 10 }));
    assert.equal(workspaces.items.some((workspace) => workspace.id === fixture.workspace.id), true);

    const getBoard = toolHandler(fixture.writeKey, publicApiUrl, "kanera_get_board");
    const boardPayload = parseToolText<{ board: { id: string }; lists: { id: string }[] }>(await getBoard({ boardId: fixture.board.id }));
    assert.equal(boardPayload.board.id, fixture.board.id);
    assert.equal(boardPayload.lists.some((list) => list.id === fixture.listId), true);

    const readBoardResource = resourceHandler(fixture.writeKey, publicApiUrl, "board");
    const resource = await readBoardResource(new URL(`kanera://board/${fixture.board.id}`), { boardId: fixture.board.id });
    const resourcePayload = JSON.parse(resource.contents[0]!.text!) as { board: { id: string }; cards?: unknown };
    assert.equal(resourcePayload.board.id, fixture.board.id);
    assert.equal(resourcePayload.cards, undefined, "the board resource must remain metadata-only");

    const createCard = toolHandler(fixture.writeKey, publicApiUrl, "kanera_create_card");
    const card = parseToolText<{ id: string; key: string; organisationKey: string; url: string; title: string }>(await createCard({
      boardId: fixture.board.id,
      listId: fixture.listId,
      title: "Created through MCP",
      description: "Created by an MCP integration test.",
    }));
    assert.equal(card.title, "Created through MCP");
    assert.match(card.key, /^[A-Z][A-Z0-9]{1,9}-1$/u);
    assert.match(card.url, new RegExp(`/o/${card.organisationKey}/c/${card.key}$`, "u"));

    const getCard = toolHandler(fixture.writeKey, publicApiUrl, "kanera_get_card");
    // A human key is a first-class MCP reference; the bridge resolves it to the UUID required by
    // the existing public card-detail endpoint without changing its authorization boundary.
    const cardDetail = parseToolText<{ card: { id: string; key: string; title: string } }>(await getCard({ cardId: card.key }));
    assert.equal(cardDetail.card.id, card.id);
    assert.equal(cardDetail.card.key, card.key);
    assert.equal(cardDetail.card.title, "Created through MCP");

    const listCardHistory = toolHandler(fixture.writeKey, publicApiUrl, "kanera_list_card_history");
    const cardHistory = parseToolText<{ items: Array<{ type: string; data: { entityId?: string; action?: string } }> }>(
      await listCardHistory({ cardId: card.key, limit: 50 }),
    );
    assert.ok(cardHistory.items.some((item) => item.type === "activity" && item.data.entityId === card.id && item.data.action === "created"));

    const listMyWorkHistory = toolHandler(fixture.writeKey, publicApiUrl, "kanera_list_my_work_history");
    const myWorkHistory = parseToolText<{ summary: { totalEvents: number }; events: Array<{ card: { id: string } }> }>(
      await listMyWorkHistory({ preset: "today", limit: 50 }),
    );
    assert.ok(myWorkHistory.summary.totalEvents >= 1);
    assert.ok(myWorkHistory.events.some((event) => event.card.id === card.id));

    await createCard({ boardId: fixture.board.id, listId: fixture.listId, title: "Second activity page" });

    const listActivity = toolHandler(fixture.writeKey, publicApiUrl, "kanera_list_activity");
    const activity = parseToolText<{ items: Array<{ type: string; data: { entityId?: string; action?: string; actorKind?: string; apiKeyName?: string } }> }>(
      await listActivity({ boardId: fixture.board.id, limit: 20 }),
    );
    const createdActivity = activity.items.find((item) => item.type === "activity" && item.data.entityId === card.id && item.data.action === "created");
    assert.equal(createdActivity?.data.actorKind, "apiKey");
    assert.equal(createdActivity?.data.apiKeyName, "MCP Write");

    const firstActivityPage = parseToolText<{ items: Array<{ data: { id: string } }>; nextCursor: string | null }>(
      await listActivity({ boardId: fixture.board.id, limit: 1 }),
    );
    assert.equal(firstActivityPage.items.length, 1);
    assert.ok(firstActivityPage.nextCursor);
    const secondActivityPage = parseToolText<{ items: Array<{ data: { id: string } }> }>(
      await listActivity({ boardId: fixture.board.id, cursor: firstActivityPage.nextCursor, limit: 1 }),
    );
    assert.equal(secondActivityPage.items.length, 1);
    assert.notEqual(secondActivityPage.items[0]!.data.id, firstActivityPage.items[0]!.data.id);
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

    // Item detail remains part of the card resource, while sub-checklists are linked in the flat
    // checklist collection by parentItemId so MCP clients can assemble the same one-level view.
    const updateItem = toolHandler(fixture.writeKey, publicApiUrl, "kanera_update_checklist_item");
    await updateItem({
      cardId: card.id,
      checklistId: checklist.id,
      itemId: item.id,
      changes: {
        description: "Coordinate the launch notes and owners.",
        completed: true,
      },
    });

    const subChecklist = parseToolText<{ id: string; parentItemId: string | null; title: string }>(
      await createChecklist({ cardId: card.id, title: "Implementation details", parentItemId: item.id }),
    );
    assert.equal(subChecklist.parentItemId, item.id);

    const subItem = parseToolText<{ id: string; text: string }>(
      await addItem({ cardId: card.id, checklistId: subChecklist.id, text: "Confirm rollout window" }),
    );
    await updateItem({ cardId: card.id, checklistId: subChecklist.id, itemId: subItem.id, changes: { completed: true } });

    const getCard = toolHandler(fixture.writeKey, publicApiUrl, "kanera_get_card");
    const detail = parseToolText<{
      checklists: Array<{
        id: string;
        parentItemId: string | null;
        items: Array<{ id: string; description: string | null; completedAt: string | null }>;
      }>;
    }>(
      await getCard({ cardId: card.id }),
    );
    const trackedItem = detail.checklists.find((c) => c.id === checklist.id)?.items.find((i) => i.id === item.id);
    assert.ok(trackedItem, "expected the checklist item to be present on the card detail");
    assert.equal(detail.checklists.find((c) => c.id === checklist.id)?.parentItemId, null);
    assert.equal(trackedItem.description, "Coordinate the launch notes and owners.");
    assert.notEqual(trackedItem.completedAt, null);

    const trackedSubChecklist = detail.checklists.find((c) => c.id === subChecklist.id);
    assert.equal(trackedSubChecklist?.parentItemId, item.id);
    assert.notEqual(trackedSubChecklist?.items.find((i) => i.id === subItem.id)?.completedAt, null);

    const getCardsContent = toolHandler(fixture.writeKey, publicApiUrl, "kanera_get_cards_content");
    const batch = parseToolText<{
      cards: Array<{ card: { id: string }; checklists: Array<{ id: string }> }>;
      missingCardIds: string[];
      truncatedCardIds: string[];
    }>(await getCardsContent({ boardId: fixture.board.id, cardIds: [card.id] }));
    assert.equal(batch.cards[0]?.card.id, card.id);
    assert.equal(batch.cards[0]?.checklists.some((entry) => entry.id === checklist.id), true);
    assert.deepEqual(batch.missingCardIds, []);
    assert.deepEqual(batch.truncatedCardIds, []);
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
    const comment = parseToolText<{ id: string }>(await addComment({ cardId: card.id, body: "First note from the agent" }));

    const updateComment = toolHandler(fixture.writeKey, publicApiUrl, "kanera_update_comment");
    await updateComment({ commentId: comment.id, body: "Edited note from the agent" });

    const setReaction = toolHandler(fixture.writeKey, publicApiUrl, "kanera_set_comment_reaction");
    await setReaction({ commentId: comment.id, type: "thumbs_up", active: true });

    const listComments = toolHandler(fixture.writeKey, publicApiUrl, "kanera_list_card_comments");
    const page = parseToolText<{ items: Array<{ body: string; reactions: Array<{ type: string }> }> }>(await listComments({ cardId: card.id }));
    const updated = page.items.find((item) => item.body === "Edited note from the agent");
    assert.ok(updated);
    assert.equal(updated.reactions.some((reaction) => reaction.type === "thumbs_up"), true);

    await setReaction({ commentId: comment.id, type: "thumbs_up", active: false });
  });
});

void test("MCP work projections and card attachment tools round-trip against the real public API", async () => {
  const fixture = await seedFixture();

  await withPublicApi(async (publicApiUrl) => {
    const createCard = toolHandler(fixture.writeKey, publicApiUrl, "kanera_create_card");
    const card = parseToolText<{ id: string }>(await createCard({
      boardId: fixture.board.id,
      listId: fixture.listId,
      title: "Projected and attached through MCP",
    }));
    const setAssignees = toolHandler(fixture.writeKey, publicApiUrl, "kanera_set_card_assignees");
    await setAssignees({ cardId: card.id, userIds: [fixture.userId] });

    const queryWork = toolHandler(fixture.personalKey, publicApiUrl, "kanera_query_work_cards");
    const workPage = parseToolText<{ cards: Array<{ id: string; lastActivityAt: string | null; lastMovedAt: string | null }> }>(await queryWork({
      lens: "my",
      scope: { boardIds: [fixture.board.id] },
      filters: { q: "Projected and attached" },
      limit: 10,
    }));
    assert.equal(workPage.cards.some((item) => item.id === card.id), true);

    const portfolio = toolHandler(fixture.personalKey, publicApiUrl, "kanera_get_portfolio_summary");
    const summary = parseToolText<{ totals: { cards: number }; buckets: Array<{ boardId: string }> }>(await portfolio({
      scope: { boardIds: [fixture.board.id] },
      days: 30,
      timeZone: "UTC",
    }));
    assert.ok(summary.totals.cards >= 1);
    assert.equal(summary.buckets.some((board) => board.boardId === fixture.board.id), true);

    const addAttachment = toolHandler(fixture.writeKey, publicApiUrl, "kanera_add_card_attachment");
    const attachment = parseToolText<{ id?: string; error?: unknown }>(await addAttachment({
      cardId: card.id,
      fileName: "pixel.gif",
      mimeType: "image/gif",
      fileBase64: "R0lGODlhAgACAPAAAP8AAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQAAAAAACH/C0ltYWdlTWFnaWNrDmdhbW1hPTAuNDU0NTQ1ACwAAAAAAgACAAACAoRRACH5BAAKAAAAIf8LSW1hZ2VNYWdpY2sOZ2FtbWE9MC40NTQ1NDUALAAAAAACAAIAgAAA/wAAAAIChFEAOw==",
      source: "attachment",
    }));
    assert.ok(attachment.id, JSON.stringify(attachment));

    const setCover = toolHandler(fixture.writeKey, publicApiUrl, "kanera_set_card_cover");
    await setCover({ cardId: card.id, attachmentId: null });
    await setCover({ cardId: card.id, attachmentId: attachment.id });

    const getCard = toolHandler(fixture.writeKey, publicApiUrl, "kanera_get_card");
    const detail = parseToolText<{ card: { coverAttachmentId: string | null }; attachments: Array<{ id: string }> }>(await getCard({ cardId: card.id }));
    assert.equal(detail.card.coverAttachmentId, attachment.id);
    assert.equal(detail.attachments.some((item) => item.id === attachment.id), true);

    const deleteAttachment = toolHandler(fixture.writeKey, publicApiUrl, "kanera_delete_card_attachment");
    await deleteAttachment({ cardId: card.id, attachmentId: attachment.id });
    const withoutAttachment = parseToolText<{ attachments: Array<{ id: string }> }>(await getCard({ cardId: card.id }));
    assert.equal(withoutAttachment.attachments.some((item) => item.id === attachment.id), false);
  });
});

void test("MCP tools surface public API scope failures as structured tool errors", async () => {
  const fixture = await seedFixture();

  await withPublicApi(async (publicApiUrl) => {
    const listWorkspaces = toolHandler(fixture.readKey, publicApiUrl, "kanera_list_workspaces");
    const workspaces = parseToolText<{ items: Array<{ id: string }> }>(await listWorkspaces({ limit: 10 }));
    assert.equal(workspaces.items.some((workspace) => workspace.id === fixture.workspace.id), true);

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
