import "../../test/setup.integration.js";
import { boards, cardAttachmentUploadLinks, cards, lists } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { db } from "../../db.js";
import { buildPublicApiServer } from "../../public-api-server.js";
import { buildIntegrationServer, testUploadsDir } from "../../test/integration.js";
import { signupOwner } from "../../test/api-fixtures.js";

// Agent-facing file and capture surfaces on the public API: single-use upload links, the
// authenticated attachment content read, and the scratchpad as a personal inbox.
const publicApiOptions = { enableWebhookDeliveryScheduler: false, logger: false, rateLimit: { enabled: false }, uploadsDir: testUploadsDir("test-agent-files-uploads") } as const;

async function seed(testName: string) {
  const app = await buildIntegrationServer({ uploadsDir: testUploadsDir("test-agent-files-uploads") });
  const { user, auth } = await signupOwner(app, { orgName: `Acme ${testName}`, email: `owner-${randomUUID()}@example.com`, displayName: "Owner" });
  const workspaceCreated = await app.inject({ method: "POST", url: "/workspaces", headers: auth, payload: { name: "Delivery" } });
  assert.equal(workspaceCreated.statusCode, 201);
  const workspace = workspaceCreated.json<{ id: string }>();
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  const [board] = await db.insert(boards).values({ workspaceId: workspace.id, name: "Board", position: "1000.0000000000" }).returning();
  const [card] = await db.insert(cards).values({ listId: list!.id, boardId: board!.id, title: "Card", position: "1000.0000000000", createdById: user.id }).returning();
  const key = async (scope: "read" | "write") => {
    const created = await app.inject({ method: "POST", url: "/me/api-keys", headers: auth, payload: { scope } });
    assert.equal(created.statusCode, 201, created.body);
    return created.json<{ id: string; secret: string }>();
  };
  const publicApi = await buildPublicApiServer(publicApiOptions);
  return { app, auth, publicApi, workspaceId: workspace.id, cardId: card!.id, key };
}

void test("an upload link accepts one raw PUT, attributes it to its creator, and is then spent", async () => {
  const { app, auth, publicApi, cardId, key } = await seed("upload-link");
  const writeKey = await key("write");
  const readKey = await key("read");
  try {
    const refused = await publicApi.inject({ method: "POST", url: `/api/v1/cards/${cardId}/attachments/upload-links`, headers: { authorization: `Bearer ${readKey.secret}` }, payload: { fileName: "run.log" } });
    assert.equal(refused.statusCode, 403, "a read-only key cannot mint upload links");

    const unsupported = await publicApi.inject({ method: "POST", url: `/api/v1/cards/${cardId}/attachments/upload-links`, headers: { authorization: `Bearer ${writeKey.secret}` }, payload: { fileName: "tool.exe" } });
    assert.equal(unsupported.statusCode, 400);

    const minted = await publicApi.inject({ method: "POST", url: `/api/v1/cards/${cardId}/attachments/upload-links`, headers: { authorization: `Bearer ${writeKey.secret}` }, payload: { fileName: "run.log" } });
    assert.equal(minted.statusCode, 201, minted.body);
    const link = minted.json<{ uploadUrl: string; method: string; mimeType: string; curl: string }>();
    assert.equal(link.method, "PUT");
    assert.equal(link.mimeType, "text/plain", "a .log file is stored as text");
    assert.match(link.curl, /^curl -fsS -T <path-to-file> '/u);
    const path = new URL(link.uploadUrl).pathname;
    const [stored] = await db.select().from(cardAttachmentUploadLinks).where(eq(cardAttachmentUploadLinks.cardId, cardId));
    assert.ok(stored && !path.includes(stored.tokenHash), "only the token hash is stored");

    // curl -T sends no meaningful content type; the link's recorded type wins.
    const log = "line one\nline two ✓\n".repeat(50);
    const uploaded = await publicApi.inject({ method: "PUT", url: path, headers: { "content-type": "application/octet-stream" }, payload: Buffer.from(log) });
    assert.equal(uploaded.statusCode, 201, uploaded.body);
    const attachment = uploaded.json<{ id: string; fileName: string; mimeType: string; byteSize: number; uploadedById: string }>();
    assert.deepEqual([attachment.fileName, attachment.mimeType, attachment.byteSize], ["run.log", "text/plain", Buffer.byteLength(log)]);

    const reused = await publicApi.inject({ method: "PUT", url: path, payload: Buffer.from("again") });
    assert.equal(reused.statusCode, 404, "a link is single-use");
    assert.equal(reused.json<{ code: string }>().code, "UPLOAD_LINK_INVALID");

    // The web client sees the attachment through the same route it always reads.
    const listed = await app.inject({ method: "GET", url: `/cards/${cardId}/attachments`, headers: auth });
    assert.ok(listed.json<{ id: string }[]>().some((row) => row.id === attachment.id));

    // The content route serves the bytes (and byte ranges) to an API key, checked live.
    const content = await publicApi.inject({ method: "GET", url: `/api/v1/cards/${cardId}/attachments/${attachment.id}/content`, headers: { authorization: `Bearer ${readKey.secret}` } });
    assert.equal(content.statusCode, 200);
    assert.equal(content.headers["content-type"], "text/plain");
    assert.equal(content.body, log);
    const range = await publicApi.inject({ method: "GET", url: `/api/v1/cards/${cardId}/attachments/${attachment.id}/content`, headers: { authorization: `Bearer ${readKey.secret}`, range: "bytes=5-99999999" } });
    assert.equal(range.statusCode, 206);
    assert.equal(range.headers["content-range"], `bytes 5-${Buffer.byteLength(log) - 1}/${Buffer.byteLength(log)}`);
    assert.equal(range.rawPayload.byteLength, Buffer.byteLength(log) - 5, "a range past the end is clamped to the file");
    const noThumbnail = await publicApi.inject({ method: "GET", url: `/api/v1/cards/${cardId}/attachments/${attachment.id}/content?variant=thumbnail`, headers: { authorization: `Bearer ${readKey.secret}` } });
    assert.equal(noThumbnail.statusCode, 404);
    const wrongCard = await publicApi.inject({ method: "GET", url: `/api/v1/cards/${randomUUID()}/attachments/${attachment.id}/content`, headers: { authorization: `Bearer ${readKey.secret}` } });
    assert.equal(wrongCard.statusCode, 404);
  } finally {
    await publicApi.close();
  }
});

void test("revoking the creating key kills its outstanding upload links", async () => {
  const { app, auth, publicApi, cardId, key } = await seed("upload-link-revoked");
  const writeKey = await key("write");
  try {
    const minted = await publicApi.inject({ method: "POST", url: `/api/v1/cards/${cardId}/attachments/upload-links`, headers: { authorization: `Bearer ${writeKey.secret}` }, payload: { fileName: "shot.png" } });
    assert.equal(minted.statusCode, 201, minted.body);
    const revoke = await app.inject({ method: "DELETE", url: `/me/api-keys/${writeKey.id}`, headers: auth });
    assert.ok(revoke.statusCode < 300, revoke.body);
    const uploaded = await publicApi.inject({ method: "PUT", url: new URL(minted.json<{ uploadUrl: string }>().uploadUrl).pathname, payload: Buffer.from("png") });
    assert.equal(uploaded.statusCode, 401);
  } finally {
    await publicApi.close();
  }
});

void test("the scratchpad is a personal-credential inbox on the public API", async () => {
  const { app, auth, publicApi, workspaceId, key } = await seed("scratchpad");
  const writeKey = await key("write");
  const readKey = await key("read");
  const writeAuth = { authorization: `Bearer ${writeKey.secret}` };
  try {
    const first = await publicApi.inject({ method: "POST", url: "/api/v1/scratchpad/capture", headers: writeAuth, payload: { text: "Call the venue\nabout parking" } });
    assert.equal(first.statusCode, 201, first.body);
    const created = first.json<{ note: { id: string; title: string; content: string; updatedAt: string }; created: boolean; item: string }>();
    assert.equal(created.created, true);
    assert.equal(created.note.title, "Inbox");
    assert.equal(created.note.content, "- [ ] Call the venue about parking", "one capture is one task line");

    const second = await publicApi.inject({ method: "POST", url: "/api/v1/scratchpad/capture", headers: writeAuth, payload: { text: "Book flights", pageTitle: "inbox" } });
    assert.equal(second.statusCode, 200, second.body);
    const appended = second.json<{ note: { id: string; content: string; updatedAt: string }; created: boolean }>();
    assert.equal(appended.created, false, "titles match case-insensitively");
    assert.equal(appended.note.id, created.note.id);
    assert.equal(appended.note.content, "- [ ] Call the venue about parking\n- [ ] Book flights");

    // The owner's web session sees the same private page.
    const pages = await app.inject({ method: "GET", url: "/scratchpad/notes", headers: auth });
    assert.deepEqual(pages.json<{ id: string }[]>().map((page) => page.id), [created.note.id]);

    // An agent replacing a page it read earlier opts into the staleness check.
    const stale = await publicApi.inject({ method: "PATCH", url: `/api/v1/scratchpad/notes/${created.note.id}`, headers: writeAuth, payload: { content: "- [x] Call the venue", baseUpdatedAt: created.note.updatedAt } });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json<{ code: string }>().code, "SCRATCHPAD_STALE");
    const fresh = await publicApi.inject({ method: "PATCH", url: `/api/v1/scratchpad/notes/${created.note.id}`, headers: writeAuth, payload: { content: "- [x] Call the venue", baseUpdatedAt: appended.note.updatedAt } });
    assert.equal(fresh.statusCode, 200, fresh.body);

    const readOnly = await publicApi.inject({ method: "POST", url: "/api/v1/scratchpad/capture", headers: { authorization: `Bearer ${readKey.secret}` }, payload: { text: "Nope" } });
    assert.equal(readOnly.statusCode, 403);
    const readList = await publicApi.inject({ method: "GET", url: "/api/v1/scratchpad/notes", headers: { authorization: `Bearer ${readKey.secret}` } });
    assert.equal(readList.statusCode, 200);

    // A workspace key authenticates as its creator; it must not open that person's private pages.
    const workspaceKey = await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/api-keys`, headers: auth, payload: { name: "Shared", scope: "write" } });
    assert.equal(workspaceKey.statusCode, 201, workspaceKey.body);
    const shared = await publicApi.inject({ method: "GET", url: "/api/v1/scratchpad/notes", headers: { authorization: `Bearer ${workspaceKey.json<{ secret: string }>().secret}` } });
    assert.equal(shared.statusCode, 403);

    const deletion = await publicApi.inject({ method: "DELETE", url: `/api/v1/scratchpad/notes/${created.note.id}`, headers: writeAuth });
    assert.equal(deletion.statusCode, 404, "page deletion stays in the web app");
  } finally {
    await publicApi.close();
  }
});
