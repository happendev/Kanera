import "../../test/setup.integration.js";
import { activityEvents, boardMembers, boards, cards, commentReactions, comments, eventOutbox, lists, users, workspaceMembers } from "@kanera/shared/schema";
import { and, eq, inArray } from "drizzle-orm";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { db } from "../../db.js";
import { buildPublicApiServer } from "../../public-api-server.js";
import { buildIntegrationServer, testUploadsDir } from "../../test/integration.js";

type ApiActivityFeedItem = {
  type: "activity";
  data: {
    actorKind: "user" | "apiKey";
    actorName: string;
    actorAvatarUrl: string | null;
  };
};
type ApiCommentFeedItem = {
  type: "comment";
  data: {
    authorKind: "user" | "apiKey";
    apiKeyId: string | null;
    apiKeyName: string | null;
    authorName: string;
    authorAvatarUrl: string | null;
  };
};

void test("GET /cards/:id/comments paginates with a descending cursor", async () => {
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
  const { accessToken, user } = signup.json();

  const workspaceCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(workspaceCreated.statusCode, 201);
  const workspace = workspaceCreated.json();

  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);

  const [board] = await db
    .insert(boards)
    .values({
      workspaceId: workspace.id,
      name: "Board",
      position: "1000.0000000000",
    })
    .returning();
  assert.ok(board);

  const [card] = await db
    .insert(cards)
    .values({
      listId: list.id,
      boardId: board.id,
      title: "Paginated comments",
      position: "1000.0000000000",
      createdById: user.id,
    })
    .returning();
  assert.ok(card);

  const oldest = new Date("2026-05-20T00:00:00.000Z");
  const middle = new Date("2026-05-21T00:00:00.000Z");
  const newest = new Date("2026-05-22T00:00:00.000Z");

  await db.insert(comments).values([
    { cardId: card.id, authorId: user.id, body: "Oldest", createdAt: oldest },
    { cardId: card.id, authorId: user.id, body: "Middle", createdAt: middle },
    { cardId: card.id, authorId: user.id, body: "Newest", createdAt: newest },
  ]);

  const firstPage = await app.inject({
    method: "GET",
    url: `/cards/${card.id}/comments?limit=2`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(firstPage.statusCode, 200);

  const firstBody = firstPage.json();
  assert.equal(firstBody.items.length, 2);
  assert.deepEqual(
    firstBody.items.map((item: { body: string }) => item.body),
    ["Newest", "Middle"],
  );
  assert.equal(firstBody.nextCursor, middle.toISOString());

  const secondPage = await app.inject({
    method: "GET",
    url: `/cards/${card.id}/comments?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(secondPage.statusCode, 200);

  const secondBody = secondPage.json();
  assert.equal(secondBody.items.length, 1);
  assert.deepEqual(
    secondBody.items.map((item: { body: string }) => item.body),
    ["Oldest"],
  );
  assert.equal(secondBody.nextCursor, null);
});

void test("card feed shows card creation before same-transaction automation activity", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Automation Feed",
      email: "owner-automation-feed@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken } = signup.json<{ accessToken: string }>();

  const workspaceCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(workspaceCreated.statusCode, 201);
  const workspace = workspaceCreated.json<{ id: string }>();

  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [board] = await db
    .insert(boards)
    .values({
      workspaceId: workspace.id,
      name: "Board",
      position: "1000.0000000000",
    })
    .returning();
  assert.ok(board);

  const automation = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/automations`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: {
      enabled: true,
      triggerType: "card_enters_list",
      triggerListId: list.id,
      applyOnCreate: true,
      applyOnMove: false,
      actions: [{ type: "set_completion", config: { completed: true } }],
    },
  });
  assert.equal(automation.statusCode, 201);

  const created = await app.inject({
    method: "POST",
    url: `/boards/${board.id}/lists/${list.id}/cards`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { title: "Automated card" },
  });
  assert.equal(created.statusCode, 201);
  const card = created.json<{ id: string }>();

  const activityRows = await db
    .select({ action: activityEvents.action, createdAt: activityEvents.createdAt })
    .from(activityEvents)
    .where(and(eq(activityEvents.entityType, "card"), eq(activityEvents.entityId, card.id)));
  assert.deepEqual(
    activityRows.map((row) => row.action).sort(),
    ["completed", "created"],
  );
  assert.equal(activityRows[0]!.createdAt.getTime(), activityRows[1]!.createdAt.getTime());

  const feed = await app.inject({
    method: "GET",
    url: `/cards/${card.id}/feed?limit=10`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(feed.statusCode, 200);
  const body = feed.json<{ items: { type: "activity"; data: { action: string } }[] }>();
  assert.deepEqual(
    body.items.filter((item) => item.type === "activity").map((item) => item.data.action).slice(0, 2),
    ["created", "completed"],
  );
});

void test("card feed shows API key name for public API card creation activity", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme API Activity",
      email: "owner-api-activity@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken } = signup.json<{ accessToken: string }>();

  const workspaceCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(workspaceCreated.statusCode, 201);
  const workspace = workspaceCreated.json<{ id: string }>();

  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [board] = await db
    .insert(boards)
    .values({
      workspaceId: workspace.id,
      name: "Board",
      position: "1000.0000000000",
    })
    .returning();
  assert.ok(board);

  const key = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/api-keys`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Zapier sync", scope: "write" },
  });
  assert.equal(key.statusCode, 201);
  const secret = key.json<{ id: string; secret: string }>();

  const publicApi = await buildPublicApiServer({
    logger: false,
    uploadsDir: testUploadsDir("test-public-uploads"),
  });
  try {
    const created = await publicApi.inject({
      method: "POST",
      url: `/api/v1/boards/${board.id}/lists/${list.id}/cards`,
      headers: { authorization: `Bearer ${secret.secret}` },
      payload: { title: "Imported card" },
    });
    assert.equal(created.statusCode, 201);
    const card = created.json<{ id: string }>();

    const [activity] = await db
      .select()
      .from(activityEvents)
      .where(and(
        eq(activityEvents.entityType, "card"),
        eq(activityEvents.entityId, card.id),
        eq(activityEvents.action, "created"),
      ));
    assert.ok(activity);
    assert.equal(activity.actorKind, "apiKey");
    assert.equal(activity.apiKeyId, secret.id);
    assert.equal(activity.apiKeyName, "Zapier sync");

    const feed = await app.inject({
      method: "GET",
      url: `/cards/${card.id}/feed`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(feed.statusCode, 200);
    const feedBody = feed.json<{ items: ApiActivityFeedItem[] }>();
    const activityItem = feedBody.items.find((item) => item.type === "activity");
    assert.ok(activityItem);
    assert.equal(activityItem.data.actorKind, "apiKey");
    assert.equal(activityItem.data.actorName, "Zapier sync");
    assert.equal(activityItem.data.actorAvatarUrl, null);

    const createdComment = await publicApi.inject({
      method: "POST",
      url: `/api/v1/cards/${card.id}/comments`,
      headers: { authorization: `Bearer ${secret.secret}` },
      payload: { body: "Synced comment" },
    });
    assert.equal(createdComment.statusCode, 201);
    const comment = createdComment.json<ApiCommentFeedItem["data"]>();
    assert.equal(comment.authorKind, "apiKey");
    assert.equal(comment.apiKeyId, secret.id);
    assert.equal(comment.apiKeyName, "Zapier sync");
    assert.equal(comment.authorName, "Zapier sync");
    assert.equal(comment.authorAvatarUrl, null);

    const commentFeed = await app.inject({
      method: "GET",
      url: `/cards/${card.id}/feed`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(commentFeed.statusCode, 200);
    const commentFeedBody = commentFeed.json<{ items: Array<ApiActivityFeedItem | ApiCommentFeedItem> }>();
    const commentItem = commentFeedBody.items.find((item): item is ApiCommentFeedItem => item.type === "comment");
    assert.ok(commentItem);
    assert.equal(commentItem.data.authorKind, "apiKey");
    assert.equal(commentItem.data.authorName, "Zapier sync");
    assert.equal(commentItem.data.authorAvatarUrl, null);
  } finally {
    await publicApi.close();
  }
});

void test("editing a comment updates the comment feed item without recording edit activity", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Comment Edit",
      email: "owner-comment-edit@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user } = signup.json();

  const workspaceCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(workspaceCreated.statusCode, 201);
  const workspace = workspaceCreated.json();

  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);

  const [board] = await db
    .insert(boards)
    .values({
      workspaceId: workspace.id,
      name: "Board",
      position: "1000.0000000000",
    })
    .returning();
  assert.ok(board);

  const [card] = await db
    .insert(cards)
    .values({
      listId: list.id,
      boardId: board.id,
      title: "Comment edits",
      position: "1000.0000000000",
      createdById: user.id,
    })
    .returning();
  assert.ok(card);

  const createComment = await app.inject({
    method: "POST",
    url: `/cards/${card.id}/comments`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { body: "Original" },
  });
  assert.equal(createComment.statusCode, 201);
  const comment = createComment.json();

  const editComment = await app.inject({
    method: "PATCH",
    url: `/comments/${comment.id}`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { body: "Edited" },
  });
  assert.equal(editComment.statusCode, 200);
  assert.equal(editComment.json().body, "Edited");

  const updatedActivities = await db
    .select()
    .from(activityEvents)
    .where(and(
      eq(activityEvents.entityType, "comment"),
      eq(activityEvents.entityId, comment.id),
      eq(activityEvents.action, "updated"),
    ));
  assert.equal(updatedActivities.length, 0);

  const feed = await app.inject({
    method: "GET",
    url: `/cards/${card.id}/feed`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(feed.statusCode, 200);
  const commentItems = feed.json().items.filter((item: { type: string }) => item.type === "comment");
  assert.equal(commentItems.length, 1);
  assert.equal(commentItems[0].data.body, "Edited");
});

void test("observers cannot react to comments", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme",
      email: "owner-reactions@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user: owner } = signup.json();

  const workspaceCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(workspaceCreated.statusCode, 201);
  const workspace = workspaceCreated.json();

  const [observer] = await db
    .insert(users)
    .values({
      clientId: owner.clientId,
      email: "observer-reactions@example.com",
      passwordHash: "x",
      displayName: "Observer",
    })
    .returning();
  assert.ok(observer);

  await db.insert(workspaceMembers).values({
    workspaceId: workspace.id,
    userId: observer.id,
    role: "member",
  });
  const observerToken = app.jwt.sign({ sub: observer.id, cid: owner.clientId, role: "member" });

  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);

  const [board] = await db
    .insert(boards)
    .values({
      workspaceId: workspace.id,
      name: "Board",
      position: "1000.0000000000",
    })
    .returning();
  assert.ok(board);

  // The observer holds a board_member row with the observer role: they can read the card and its
  // comments but must not be able to add reactions (an editor-level write).
  await db.insert(boardMembers).values({
    boardId: board.id,
    userId: observer.id,
    role: "observer",
  });

  const [card] = await db
    .insert(cards)
    .values({
      listId: list.id,
      boardId: board.id,
      title: "Reaction permissions",
      position: "1000.0000000000",
      createdById: owner.id,
    })
    .returning();
  assert.ok(card);

  const [comment] = await db
    .insert(comments)
    .values({
      cardId: card.id,
      authorId: owner.id,
      body: "Please review this.",
    })
    .returning();
  assert.ok(comment);

  const addReaction = await app.inject({
    method: "POST",
    url: `/comments/${comment.id}/reactions`,
    headers: { authorization: `Bearer ${observerToken}` },
    payload: { type: "thumbs_up" },
  });
  assert.equal(addReaction.statusCode, 403);

  const existingReactions = await db.select().from(commentReactions).where(eq(commentReactions.commentId, comment.id));
  assert.equal(existingReactions.length, 0);
});

void test("bulk comment deletion is atomic, owner-only, and emits one event per deleted comment", async () => {
  const app = await buildIntegrationServer();
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Bulk Comment Delete",
      email: "owner-bulk-comment-delete@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user: owner } = signup.json<{ accessToken: string; user: { id: string; clientId: string } }>();
  const auth = { authorization: `Bearer ${accessToken}` };
  const workspaceCreated = await app.inject({ method: "POST", url: "/workspaces", headers: auth, payload: { name: "Delivery" } });
  assert.equal(workspaceCreated.statusCode, 201);
  const workspace = workspaceCreated.json<{ id: string }>();
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [board] = await db.insert(boards).values({ workspaceId: workspace.id, name: "Board", position: "1000.0000000000" }).returning();
  assert.ok(board);
  const [card] = await db.insert(cards).values({ listId: list.id, boardId: board.id, title: "Comments", position: "1000.0000000000", createdById: owner.id }).returning();
  assert.ok(card);
  const [other] = await db.insert(users).values({ clientId: owner.clientId, email: "other-bulk-comment-delete@example.com", passwordHash: "x", displayName: "Other" }).returning();
  assert.ok(other);
  const [first, second, otherComment] = await db.insert(comments).values([
    { cardId: card.id, authorId: owner.id, body: "First" },
    { cardId: card.id, authorId: owner.id, body: "Second" },
    { cardId: card.id, authorId: other.id, body: "Other author's comment" },
  ]).returning();
  assert.ok(first && second && otherComment);

  const rejected = await app.inject({
    method: "POST",
    url: `/boards/${board.id}/comments/bulk/delete`,
    headers: auth,
    payload: { commentIds: [first.id, otherComment.id] },
  });
  assert.equal(rejected.statusCode, 403);
  assert.equal(await db.$count(comments, inArray(comments.id, [first.id, otherComment.id])), 2);

  const deleted = await app.inject({
    method: "POST",
    url: `/boards/${board.id}/comments/bulk/delete`,
    headers: auth,
    payload: { commentIds: [first.id, second.id] },
  });
  assert.equal(deleted.statusCode, 200);
  assert.deepEqual(deleted.json<{ deleted: number; commentIds: string[] }>(), { deleted: 2, commentIds: [first.id, second.id] });
  assert.equal(await db.$count(comments, inArray(comments.id, [first.id, second.id])), 0);
  assert.equal(await db.$count(comments, eq(comments.id, otherComment.id)), 1);
  assert.equal(await db.$count(activityEvents, and(eq(activityEvents.action, "deleted"), inArray(activityEvents.entityId, [first.id, second.id]))), 2);
  assert.equal(await db.$count(eventOutbox, and(eq(eventOutbox.boardId, board.id), eq(eventOutbox.eventType, "comment:deleted"))), 2);

  await app.close();
});

void test("bulk comment creation validates atomically and preserves request order", async () => {
  const app = await buildIntegrationServer();
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Bulk Comment Create",
      email: "owner-bulk-comment-create@example.com",
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user: owner } = signup.json<{ accessToken: string; user: { id: string } }>();
  const auth = { authorization: `Bearer ${accessToken}` };
  const workspaceCreated = await app.inject({ method: "POST", url: "/workspaces", headers: auth, payload: { name: "Delivery" } });
  assert.equal(workspaceCreated.statusCode, 201);
  const workspace = workspaceCreated.json<{ id: string }>();
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  assert.ok(list);
  const [board] = await db.insert(boards).values({ workspaceId: workspace.id, name: "Board", position: "1000.0000000000" }).returning();
  assert.ok(board);
  const [card] = await db.insert(cards).values({ listId: list.id, boardId: board.id, title: "Comments", position: "1000.0000000000", createdById: owner.id }).returning();
  assert.ok(card);

  const rejected = await app.inject({
    method: "POST",
    url: `/boards/${board.id}/comments/bulk/create`,
    headers: auth,
    payload: { comments: [{ cardId: card.id, body: "First" }, { cardId: randomUUID(), body: "Invalid" }] },
  });
  assert.equal(rejected.statusCode, 404);
  assert.equal(await db.$count(comments, eq(comments.cardId, card.id)), 0);

  const created = await app.inject({
    method: "POST",
    url: `/boards/${board.id}/comments/bulk/create`,
    headers: auth,
    payload: { comments: [{ cardId: card.id, body: "First" }, { cardId: card.id, body: "Second" }] },
  });
  assert.equal(created.statusCode, 201);
  const result = created.json<{ created: number; comments: Array<{ id: string; body: string }> }>();
  assert.equal(result.created, 2);
  assert.deepEqual(result.comments.map((comment) => comment.body), ["First", "Second"]);
  assert.equal(await db.$count(activityEvents, and(eq(activityEvents.action, "created"), inArray(activityEvents.entityId, result.comments.map((comment) => comment.id)))), 2);
  const outboxRows = await db.select().from(eventOutbox).where(and(
    eq(eventOutbox.boardId, board.id),
    eq(eventOutbox.eventType, "comment:created"),
  ));
  assert.equal(outboxRows.length, 2);

  await app.close();
});
