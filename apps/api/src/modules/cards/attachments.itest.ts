import "../../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { expandCardSummary, type CompactCardSummary } from "@kanera/shared/events";
import { boardMembers, boards, cardAttachments, cards, clients, lists } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { getOrgStorageUsage } from "../../lib/entitlements.js";
import { buildPublicApiServer } from "../../public-api-server.js";
import { buildIntegrationServer, testUploadsDir } from "../../test/integration.js";

async function setupCard() {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme",
      email: "owner@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json<{ accessToken: string; user: { id: string; clientId: string } }>();

  const created = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(created.statusCode, 201);
  const workspace = created.json<{ id: string }>();

  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Roadmap", position: "1000.0000000000" })
    .returning();
  const [card] = await db
    .insert(cards)
    .values({
      listId: list!.id,
      boardId: board!.id,
      title: "Inline images",
      position: "1000.0000000000",
      createdById: user.id,
    })
    .returning();

  return { app, accessToken, user, workspace, list: list!, board: board!, card: card! };
}

function svgForm(fileName: string) {
  const form = new FormData();
  form.append(
    "file",
    new Blob([
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>',
    ], { type: "image/svg+xml" }),
    fileName,
  );
  return form;
}

function textForm(fileName: string, body: string) {
  const form = new FormData();
  form.append("file", new Blob([body], { type: "text/plain" }), fileName);
  return form;
}

function mediaPath(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname.replace(/^\/api/, "")}${parsed.search}`;
}

void test("description images can be uploaded as card attachments and embedded inline", async () => {
  const { app, accessToken, card } = await setupCard();

  const upload = await app.inject({
    method: "POST",
    url: `/cards/${card.id}/attachments?source=description`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: svgForm("trello-description.svg"),
  });
  assert.equal(upload.statusCode, 201);
  const attachment = upload.json<{ id: string; url: string; source: string; commentId: string | null }>();
  assert.equal(attachment.source, "description");
  assert.equal(attachment.commentId, null);
  assert.equal(new URL(attachment.url).searchParams.get("fn"), "trello-description.svg");

  const mediaUrl = new URL(attachment.url);
  const download = await app.inject({
    method: "GET",
    url: `${mediaUrl.pathname.replace(/^\/api/, "")}${mediaUrl.search}`,
  });
  assert.equal(download.statusCode, 200);
  assert.equal(
    download.headers["content-disposition"],
    `attachment; filename="trello-description.svg"; filename*=UTF-8''trello-description.svg`,
  );

  const partial = await app.inject({
    method: "GET",
    url: `${mediaUrl.pathname.replace(/^\/api/, "")}${mediaUrl.search}`,
    headers: { range: "bytes=0-10" },
  });
  assert.equal(partial.statusCode, 206);
  assert.equal(partial.headers["content-range"], "bytes 0-10/110");
  assert.equal(partial.headers["accept-ranges"], "bytes");

  const update = await app.inject({
    method: "PATCH",
    url: `/cards/${card.id}`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { description: `Before\n\n![Trello image](${attachment.url})\n\nAfter` },
  });
  assert.equal(update.statusCode, 200);
  assert.match(update.json<{ description: string }>().description, /!\[Trello image\]\([^)]*\/media\/[^)]+\)/);

  const detail = await app.inject({
    method: "GET",
    url: `/cards/${card.id}/detail`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(detail.statusCode, 200);
  const body = detail.json<{ card: { description: string }; attachments: Array<{ id: string; source: string; commentId: string | null }> }>();
  assert.match(body.card.description, /!\[Trello image\]\([^)]*\/media\/[^)]+\)/);
  assert.deepEqual(
    body.attachments.map((item) => ({ id: item.id, source: item.source, commentId: item.commentId })),
    [{ id: attachment.id, source: "description", commentId: null }],
  );
});

void test("comment images can be uploaded as card attachments and embedded inline", async () => {
  const { app, accessToken, card } = await setupCard();

  const upload = await app.inject({
    method: "POST",
    url: `/cards/${card.id}/attachments?source=comment`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: svgForm("trello-comment.svg"),
  });
  assert.equal(upload.statusCode, 201);
  const attachment = upload.json<{ id: string; url: string }>();

  const created = await app.inject({
    method: "POST",
    url: `/cards/${card.id}/comments`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: {
      body: `Trello said:\n\n![Inline comment image](${attachment.url})`,
      attachmentIds: [attachment.id],
    },
  });
  assert.equal(created.statusCode, 201);
  const comment = created.json<{ id: string; body: string }>();
  assert.match(comment.body, /!\[Inline comment image\]\([^)]*\/media\/[^)]+\)/);

  const attachments = await app.inject({
    method: "GET",
    url: `/cards/${card.id}/attachments`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(attachments.statusCode, 200);
  assert.deepEqual(
    attachments.json<Array<{ id: string; source: string; commentId: string | null }>>()
      .map((item) => ({ id: item.id, source: item.source, commentId: item.commentId })),
    [{ id: attachment.id, source: "comment", commentId: comment.id }],
  );
});

void test("cross-org board guests receive host-owned attachment and cover media URLs", async () => {
  const { app, accessToken, user, board, card } = await setupCard();

  const guestSignup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { orgName: "Guest Org", email: "attachment-reader-guest@example.com", password: "Abc12345", displayName: "Guest" },
  });
  assert.equal(guestSignup.statusCode, 200);
  const guest = guestSignup.json<{ accessToken: string; user: { id: string; clientId: string } }>();
  assert.notEqual(guest.user.clientId, user.clientId);
  await db.insert(boardMembers).values({ boardId: board.id, userId: guest.user.id, role: "observer" });

  const upload = await app.inject({
    method: "POST",
    url: `/cards/${card.id}/attachments`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: svgForm("host-cover.svg"),
  });
  assert.equal(upload.statusCode, 201);
  const uploaded = upload.json<{ id: string; url: string }>();
  assert.match(new URL(uploaded.url).pathname, new RegExp(`/api/media/${user.clientId}/`));

  const detail = await app.inject({
    method: "GET",
    url: `/cards/${card.id}/detail`,
    headers: { authorization: `Bearer ${guest.accessToken}` },
  });
  assert.equal(detail.statusCode, 200);
  const detailBody = detail.json<{ attachments: Array<{ id: string; url: string }> }>();
  assert.equal(detailBody.attachments[0]?.id, uploaded.id);
  assert.match(new URL(detailBody.attachments[0]!.url).pathname, new RegExp(`/api/media/${user.clientId}/`));

  const attachments = await app.inject({
    method: "GET",
    url: `/cards/${card.id}/attachments`,
    headers: { authorization: `Bearer ${guest.accessToken}` },
  });
  assert.equal(attachments.statusCode, 200);
  const attachmentRows = attachments.json<Array<{ id: string; url: string }>>();
  assert.equal(attachmentRows[0]?.id, uploaded.id);
  assert.match(new URL(attachmentRows[0]!.url).pathname, new RegExp(`/api/media/${user.clientId}/`));

  const download = await app.inject({ method: "GET", url: mediaPath(attachmentRows[0]!.url) });
  assert.equal(download.statusCode, 200);

  const opened = await app.inject({
    method: "POST",
    url: `/boards/${board.id}/open`,
    headers: { authorization: `Bearer ${guest.accessToken}` },
  });
  assert.equal(opened.statusCode, 200);
  const openBody = opened.json<{ cards: CompactCardSummary[] }>();
  const summary = openBody.cards.map(expandCardSummary).find((item) => item.id === card.id);
  assert.ok(summary?.coverUrl);
  assert.match(new URL(summary.coverUrl).pathname, new RegExp(`/api/media/${user.clientId}/`));
  const coverDownload = await app.inject({ method: "GET", url: mediaPath(summary.coverUrl) });
  assert.equal(coverDownload.statusCode, 200);
});

void test("API key requests reject inline media that was not uploaded to Kanera", async () => {
  const { app, accessToken, workspace, list, board, card } = await setupCard();

  const key = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/api-keys`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Trello sync", scope: "write" },
  });
  assert.equal(key.statusCode, 201);
  const secret = key.json<{ secret: string }>().secret;

  const publicApi = await buildPublicApiServer({
    logger: false,
    uploadsDir: testUploadsDir("test-public-uploads"),
  });
  try {
    const createCard = await publicApi.inject({
      method: "POST",
      url: `/api/v1/boards/${board.id}/lists/${list.id}/cards`,
      headers: { authorization: `Bearer ${secret}` },
      payload: {
        title: "Imported Trello card",
        description: "![Trello image](https://trello.com/1/cards/card-id/attachments/image.png)",
      },
    });
    assert.equal(createCard.statusCode, 400);
    assert.equal(
      createCard.json<{ message: string }>().message,
      "inline media from integrations must be uploaded to Kanera before embedding",
    );

    const createComment = await publicApi.inject({
      method: "POST",
      url: `/api/v1/cards/${card.id}/comments`,
      headers: { authorization: `Bearer ${secret}` },
      payload: {
        body: '<img src="https://trello.com/1/cards/card-id/attachments/image.png">',
      },
    });
    assert.equal(createComment.statusCode, 400);
    assert.equal(
      createComment.json<{ message: string }>().message,
      "inline media from integrations must be uploaded to Kanera before embedding",
    );
  } finally {
    await publicApi.close();
  }
});

void test("API key card creation returns a web URL", async () => {
  const { app, accessToken, workspace, list, board } = await setupCard();

  const key = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/api-keys`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Trello sync", scope: "write" },
  });
  assert.equal(key.statusCode, 201);
  const secret = key.json<{ secret: string }>().secret;

  const publicApi = await buildPublicApiServer({
    logger: false,
    uploadsDir: testUploadsDir("test-public-uploads"),
  });
  try {
    const createCard = await publicApi.inject({
      method: "POST",
      url: `/api/v1/boards/${board.id}/lists/${list.id}/cards`,
      headers: { authorization: `Bearer ${secret}` },
      payload: {
        title: "Imported Trello card",
        description: "Synced from Trello",
      },
    });

    assert.equal(createCard.statusCode, 201);
    const body = createCard.json<{ id: string; url: string }>();
    assert.equal(body.url, `http://web.test/b/${board.id}/c/${body.id}`);
  } finally {
    await publicApi.close();
  }
});

void test("API key requests can embed Kanera media after uploading it", async () => {
  const { app, accessToken, workspace, card } = await setupCard();

  const key = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/api-keys`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Trello sync", scope: "write" },
  });
  assert.equal(key.statusCode, 201);
  const secret = key.json<{ secret: string }>().secret;

  const publicApi = await buildPublicApiServer({
    logger: false,
    uploadsDir: testUploadsDir("test-public-uploads"),
  });
  try {
    const upload = await publicApi.inject({
      method: "POST",
      url: `/api/v1/cards/${card.id}/attachments?source=description`,
      headers: { authorization: `Bearer ${secret}` },
      payload: svgForm("trello-description.svg"),
    });
    assert.equal(upload.statusCode, 201);
    const attachment = upload.json<{ id: string; url: string }>();
    assert.equal(new URL(attachment.url).searchParams.get("fn"), "trello-description.svg");

    const update = await publicApi.inject({
      method: "PATCH",
      url: `/api/v1/cards/${card.id}`,
      headers: { authorization: `Bearer ${secret}` },
      payload: { description: `![Trello image](${attachment.url})` },
    });
    assert.equal(update.statusCode, 200);
    assert.match(update.json<{ description: string }>().description, /!\[Trello image\]\([^)]*\/media\/[^)]+\)/);
  } finally {
    await publicApi.close();
  }
});

void test("hosted attachment uploads are blocked when the board owner's org exceeds storage quota", async () => {
  const previousMode = env.KANERA_DEPLOYMENT_MODE;
  env.KANERA_DEPLOYMENT_MODE = "hosted";
  try {
    const { app, accessToken, user, card } = await setupCard();
    await db.update(clients).set({ plan: "free", billingStatus: "none", storageQuotaBytes: 20 }).where(eq(clients.id, user.clientId));

    const upload = await app.inject({
      method: "POST",
      url: `/cards/${card.id}/attachments`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: textForm("quota.txt", "this file is bigger than twenty bytes"),
    });

    assert.equal(upload.statusCode, 403);
    const body = upload.json<{ code: string; limit: string; quotaBytes: number; attemptedBytes: number; message: string }>();
    assert.equal(body.code, "STORAGE_QUOTA_EXCEEDED");
    assert.equal(body.limit, "storage");
    assert.equal(body.quotaBytes, 20);
    assert.ok(body.attemptedBytes > 20);
    assert.match(body.message, /storage allowance/);
  } finally {
    env.KANERA_DEPLOYMENT_MODE = previousMode;
  }
});

void test("a full org rejects further uploads up front with STORAGE_QUOTA_EXCEEDED", async () => {
  const previousMode = env.KANERA_DEPLOYMENT_MODE;
  const previousFreeQuota = env.HOSTED_FREE_STORAGE_QUOTA_BYTES;
  env.KANERA_DEPLOYMENT_MODE = "hosted";
  env.HOSTED_FREE_STORAGE_QUOTA_BYTES = 12;
  try {
    const { app, accessToken, user, card } = await setupCard();
    await db.update(clients).set({ plan: "free", billingStatus: "none" }).where(eq(clients.id, user.clientId));

    // Fill the pool exactly (12 bytes used of 12).
    const fill = await app.inject({
      method: "POST",
      url: `/cards/${card.id}/attachments`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: textForm("fill.txt", "exactly12345"),
    });
    assert.equal(fill.statusCode, 201);

    // The org is now full, so even a 1-byte upload is rejected (via the up-front isStorageFull guard
    // that fires before the request body is read).
    const blocked = await app.inject({
      method: "POST",
      url: `/cards/${card.id}/attachments`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: textForm("more.txt", "x"),
    });
    assert.equal(blocked.statusCode, 403);
    assert.equal(blocked.json<{ code: string }>().code, "STORAGE_QUOTA_EXCEEDED");
  } finally {
    env.KANERA_DEPLOYMENT_MODE = previousMode;
    env.HOSTED_FREE_STORAGE_QUOTA_BYTES = previousFreeQuota;
  }
});

void test("hosted free attachment uploads are capped at 5 MiB per file", async () => {
  const previousMode = env.KANERA_DEPLOYMENT_MODE;
  const previousFreeQuota = env.HOSTED_FREE_STORAGE_QUOTA_BYTES;
  env.KANERA_DEPLOYMENT_MODE = "hosted";
  env.HOSTED_FREE_STORAGE_QUOTA_BYTES = 1024 * 1024 * 1024;
  try {
    const { app, accessToken, user, card } = await setupCard();
    await db.update(clients).set({ plan: "free", billingStatus: "none" }).where(eq(clients.id, user.clientId));

    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: "text/plain" }), "large.txt");
    const upload = await app.inject({
      method: "POST",
      url: `/cards/${card.id}/attachments`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: form,
    });

    assert.equal(upload.statusCode, 400);
    const body = upload.json<{ code: string; maxFileBytes: number }>();
    assert.equal(body.code, "FILE_TOO_LARGE");
    assert.equal(body.maxFileBytes, 5 * 1024 * 1024);
  } finally {
    env.KANERA_DEPLOYMENT_MODE = previousMode;
    env.HOSTED_FREE_STORAGE_QUOTA_BYTES = previousFreeQuota;
  }
});

void test("hosted free plan attachment uploads stay capped even if billing status is stale trialing", async () => {
  const previousMode = env.KANERA_DEPLOYMENT_MODE;
  const previousFreeQuota = env.HOSTED_FREE_STORAGE_QUOTA_BYTES;
  env.KANERA_DEPLOYMENT_MODE = "hosted";
  env.HOSTED_FREE_STORAGE_QUOTA_BYTES = 1024 * 1024 * 1024;
  try {
    const { app, accessToken, user, card } = await setupCard();
    await db.update(clients).set({ plan: "free", billingStatus: "trialing" }).where(eq(clients.id, user.clientId));

    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: "text/plain" }), "large.txt");
    const upload = await app.inject({
      method: "POST",
      url: `/cards/${card.id}/attachments`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: form,
    });

    assert.equal(upload.statusCode, 400);
    const body = upload.json<{ code: string; maxFileBytes: number }>();
    assert.equal(body.code, "FILE_TOO_LARGE");
    assert.equal(body.maxFileBytes, 5 * 1024 * 1024);
  } finally {
    env.KANERA_DEPLOYMENT_MODE = previousMode;
    env.HOSTED_FREE_STORAGE_QUOTA_BYTES = previousFreeQuota;
  }
});

void test("self-hosted attachment uploads ignore hosted quota settings and /me reports unlimited usage", async () => {
  const previousMode = env.KANERA_DEPLOYMENT_MODE;
  const previousFreeQuota = env.HOSTED_FREE_STORAGE_QUOTA_BYTES;
  env.KANERA_DEPLOYMENT_MODE = "self_hosted";
  env.HOSTED_FREE_STORAGE_QUOTA_BYTES = 1;
  try {
    const { app, accessToken, card } = await setupCard();
    const upload = await app.inject({
      method: "POST",
      url: `/cards/${card.id}/attachments`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: textForm("self-hosted.txt", "allowed"),
    });
    assert.equal(upload.statusCode, 201);

    const me = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(me.statusCode, 200);
    const body = me.json<{ storageUsage: { usedBytes: number; quotaBytes: number | null; remainingBytes: number | null; limited: boolean } }>();
    assert.equal(body.storageUsage.usedBytes, 7);
    assert.equal(body.storageUsage.quotaBytes, null);
    assert.equal(body.storageUsage.remainingBytes, null);
    assert.equal(body.storageUsage.limited, false);
  } finally {
    env.KANERA_DEPLOYMENT_MODE = previousMode;
    env.HOSTED_FREE_STORAGE_QUOTA_BYTES = previousFreeQuota;
  }
});

void test("public API attachment uploads count against the board owner's org storage quota", async () => {
  const previousMode = env.KANERA_DEPLOYMENT_MODE;
  const previousPaidQuota = env.HOSTED_PAID_STORAGE_QUOTA_BYTES;
  env.KANERA_DEPLOYMENT_MODE = "hosted";
  // Keep the org on its (paid) trial so public API access stays enabled — hosted API keys require a
  // paid tier to both create and authenticate — but shrink the paid quota so the upload still busts it.
  env.HOSTED_PAID_STORAGE_QUOTA_BYTES = 12;
  try {
    const { app, accessToken, workspace, card } = await setupCard();

    const key = await app.inject({
      method: "POST",
      url: `/workspaces/${workspace.id}/api-keys`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: "Quota sync", scope: "write" },
    });
    assert.equal(key.statusCode, 201);
    const secret = key.json<{ secret: string }>().secret;

    const publicApi = await buildPublicApiServer({
      logger: false,
      uploadsDir: testUploadsDir("test-public-uploads"),
    });
    try {
      const upload = await publicApi.inject({
        method: "POST",
        url: `/api/v1/cards/${card.id}/attachments`,
        headers: { authorization: `Bearer ${secret}` },
        payload: textForm("api-quota.txt", "too much storage"),
      });

      assert.equal(upload.statusCode, 403);
      assert.equal(upload.json<{ code: string }>().code, "STORAGE_QUOTA_EXCEEDED");

      const rows = await db.select().from(cardAttachments).where(eq(cardAttachments.cardId, card.id));
      assert.equal(rows.length, 0);
    } finally {
      await publicApi.close();
    }
  } finally {
    env.KANERA_DEPLOYMENT_MODE = previousMode;
    env.HOSTED_PAID_STORAGE_QUOTA_BYTES = previousPaidQuota;
  }
});

void test("cross-org guest uploads count against the host board owner's org, not the guest's own free org", async () => {
  const previousMode = env.KANERA_DEPLOYMENT_MODE;
  const previousFreeQuota = env.HOSTED_FREE_STORAGE_QUOTA_BYTES;
  env.KANERA_DEPLOYMENT_MODE = "hosted";
  // Tiny free quota: if the guest's OWN (free) org were charged this upload would be rejected.
  // It succeeds only because storage is host-pays — the paid host org absorbs the bytes.
  env.HOSTED_FREE_STORAGE_QUOTA_BYTES = 5;
  try {
    const { app, accessToken, user, card, board } = await setupCard();
    // Host org A is paid, so its quota is the generous paid allowance.
    await db.update(clients).set({ plan: "paid", billingStatus: "active" }).where(eq(clients.id, user.clientId));

    // Guest user B lives in their own brand-new free org.
    const guestSignup = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { orgName: "Guestable", email: "guest@example.com", password: "Abc12345", displayName: "Guest" },
    });
    assert.equal(guestSignup.statusCode, 200);
    const guest = guestSignup.json<{ accessToken: string; user: { id: string; clientId: string } }>();
    assert.notEqual(guest.user.clientId, user.clientId);

    // Make B a cross-org guest member on host org A's board (direct insert bypasses invite-time gating).
    await db.insert(boardMembers).values({ boardId: board.id, userId: guest.user.id, role: "editor" });

    const upload = await app.inject({
      method: "POST",
      url: `/cards/${card.id}/attachments`,
      headers: { authorization: `Bearer ${guest.accessToken}` },
      payload: textForm("guest.txt", "this exceeds the guest free quota"),
    });
    assert.equal(upload.statusCode, 201);
    const [stored] = await db.select().from(cardAttachments).where(eq(cardAttachments.cardId, card.id)).limit(1);
    assert.equal(stored?.clientId, user.clientId);

    // Bytes count against the host org A; the guest's own org pool stays empty.
    const hostUsage = await getOrgStorageUsage(db, user.clientId);
    const guestUsage = await getOrgStorageUsage(db, guest.user.clientId);
    assert.ok(hostUsage.usedBytes > 5);
    assert.equal(guestUsage.usedBytes, 0);

    // The guest's /me reflects their own (empty) org pool, not the host's usage.
    const me = await app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${guest.accessToken}` } });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json<{ storageUsage: { usedBytes: number } }>().storageUsage.usedBytes, 0);

    const hostDetail = await app.inject({
      method: "GET",
      url: `/cards/${card.id}/detail`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(hostDetail.statusCode, 200);
    const detailAttachment = hostDetail.json<{ attachments: Array<{ id: string; url: string }> }>().attachments[0];
    assert.ok(detailAttachment);
    assert.match(new URL(detailAttachment.url).pathname, new RegExp(`/api/media/${guest.user.clientId}/`));

    const hostAttachments = await app.inject({
      method: "GET",
      url: `/cards/${card.id}/attachments`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(hostAttachments.statusCode, 200);
    const listedAttachment = hostAttachments.json<Array<{ id: string; url: string }>>()[0];
    assert.ok(listedAttachment);
    assert.match(new URL(listedAttachment.url).pathname, new RegExp(`/api/media/${guest.user.clientId}/`));
    const download = await app.inject({ method: "GET", url: mediaPath(listedAttachment.url) });
    assert.equal(download.statusCode, 200);
  } finally {
    env.KANERA_DEPLOYMENT_MODE = previousMode;
    env.HOSTED_FREE_STORAGE_QUOTA_BYTES = previousFreeQuota;
  }
});
