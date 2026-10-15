import "../../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { boardMembers, boards, cardAttachmentReactions, cards, emailQueue, eventOutbox, lists, notifications, workspaceMembers } from "@kanera/shared/schema";
import { and, eq } from "drizzle-orm";
import { db } from "../../db.js";
import { buildIntegrationServer } from "../../test/integration.js";
import { signupOwner } from "../../test/api-fixtures.js";
import { insertTestUsers } from "../../test/user-fixtures.js";

type DetailAttachment = { id: string; reactions?: Array<{ type: string; count: number; userIds: string[] }> };

void test("attachment reactions: editors react to others' uploads, idempotently, and see them on card detail", async () => {
  const app = await buildIntegrationServer();
  const { accessToken, user: owner } = await signupOwner(app, { orgName: "Acme", email: "owner-attachment-reactions@example.com", displayName: "Owner" });
  const ownerAuth = { authorization: `Bearer ${accessToken}` };

  const created = await app.inject({ method: "POST", url: "/workspaces", headers: ownerAuth, payload: { name: "Delivery" } });
  assert.equal(created.statusCode, 201);
  const workspace = created.json<{ id: string }>();
  const [list] = await db.select().from(lists).where(eq(lists.workspaceId, workspace.id)).limit(1);
  const [board] = await db.insert(boards).values({ workspaceId: workspace.id, name: "Roadmap", position: "1000.0000000000" }).returning();
  const [card] = await db
    .insert(cards)
    .values({ listId: list!.id, boardId: board!.id, title: "Screenshots", position: "1000.0000000000", createdById: owner.id })
    .returning();

  const [editor, observer] = await insertTestUsers(db, [
    { clientId: owner.clientId, email: "editor-attachment-reactions@example.com", passwordHash: "x", displayName: "Editor" },
    { clientId: owner.clientId, email: "observer-attachment-reactions@example.com", passwordHash: "x", displayName: "Observer" },
  ]).returning();
  await db.insert(workspaceMembers).values([
    { workspaceId: workspace.id, userId: editor!.id, role: "member" },
    { workspaceId: workspace.id, userId: observer!.id, role: "member" },
  ]);
  // Real boards materialize admin access as a row; reaction notifications use board membership.
  await db.insert(boardMembers).values([
    { boardId: board!.id, userId: owner.id, role: "editor" },
    { boardId: board!.id, userId: editor!.id, role: "editor" },
    { boardId: board!.id, userId: observer!.id, role: "observer" },
  ]);
  const editorAuth = { authorization: `Bearer ${app.jwt.sign({ sub: editor!.id, cid: owner.clientId, role: "member" })}` };
  const observerAuth = { authorization: `Bearer ${app.jwt.sign({ sub: observer!.id, cid: owner.clientId, role: "member" })}` };

  const form = new FormData();
  form.append("file", new Blob(["built it"], { type: "text/plain" }), "screenshot.txt");
  const upload = await app.inject({ method: "POST", url: `/cards/${card!.id}/attachments`, headers: ownerAuth, payload: form });
  assert.equal(upload.statusCode, 201, upload.body);
  const attachment = upload.json<{ id: string }>();
  const ownerReacted = () => db.select().from(notifications).where(and(eq(notifications.userId, owner.id), eq(notifications.reason, "reacted")));
  const reactionEmails = () => db.select().from(emailQueue).where(eq(emailQueue.type, "reaction_added"));
  // Email for a thumbs-up is opt-in; turn it on to prove it is sent once, not once per toggle.
  const optIn = await app.inject({ method: "PATCH", url: "/notifications/settings", headers: ownerAuth, payload: { types: { reactionAdded: { email: true } } } });
  assert.equal(optIn.statusCode, 200, optIn.body);
  const react = (headers: Record<string, string>) =>
    app.inject({ method: "POST", url: `/attachments/${attachment.id}/reactions`, headers, payload: { type: "thumbs_up" } });

  assert.equal((await react(ownerAuth)).statusCode, 400, "uploaders cannot react to their own file");
  assert.equal((await react(observerAuth)).statusCode, 403, "reacting is an editor-level write");
  assert.equal((await react(editorAuth)).statusCode, 204);
  assert.equal((await react(editorAuth)).statusCode, 204, "a repeated reaction is a no-op");

  const detail = await app.inject({ method: "GET", url: `/cards/${card!.id}/detail`, headers: ownerAuth });
  assert.equal(detail.statusCode, 200, detail.body);
  const row = detail.json<{ attachments: DetailAttachment[] }>().attachments.find((a) => a.id === attachment.id);
  assert.deepEqual(row?.reactions?.map((r) => ({ type: r.type, count: r.count, userIds: r.userIds })), [
    { type: "thumbs_up", count: 1, userIds: [editor!.id] },
  ]);
  const added = await db.select().from(eventOutbox).where(and(eq(eventOutbox.boardId, board!.id), eq(eventOutbox.eventType, "card:attachment:reaction:added")));
  assert.equal(added.length, 1, "only the first reaction broadcasts");
  assert.equal((await ownerReacted()).length, 1, "the uploader is notified once");
  assert.equal((await reactionEmails()).length, 1);
  const inbox = await app.inject({ method: "GET", url: "/notifications", headers: ownerAuth });
  const reactedItem = inbox.json<{ items: Array<{ reason: string; attachment: { fileName: string } | null }> }>().items.find((item) => item.reason === "reacted");
  // The drawer previews the file that got the thumbs-up, as it does for the upload itself.
  assert.equal(reactedItem?.attachment?.fileName, "screenshot.txt");

  const unreact = await app.inject({ method: "DELETE", url: `/attachments/${attachment.id}/reactions/thumbs_up`, headers: editorAuth });
  assert.equal(unreact.statusCode, 204);
  const afterUnreact = await app.inject({ method: "GET", url: `/cards/${card!.id}/detail`, headers: ownerAuth });
  assert.deepEqual(afterUnreact.json<{ attachments: DetailAttachment[] }>().attachments.find((a) => a.id === attachment.id)?.reactions, []);
  assert.equal((await ownerReacted()).length, 0, "un-reacting withdraws the notification");

  assert.equal((await react(editorAuth)).statusCode, 204);
  const restored = await ownerReacted();
  assert.equal(restored.length, 1, "re-reacting restores it");
  assert.equal(restored[0]!.readAt, null);
  assert.equal((await reactionEmails()).length, 1, "a toggled reaction never sends again");

  // Comment likes notify their author the same way.
  const comment = await app.inject({ method: "POST", url: `/cards/${card!.id}/comments`, headers: ownerAuth, payload: { body: "Shipped the new layout" } });
  assert.equal(comment.statusCode, 201, comment.body);
  const commentId = comment.json<{ id: string }>().id;
  const likeComment = await app.inject({ method: "POST", url: `/comments/${commentId}/reactions`, headers: editorAuth, payload: { type: "thumbs_up" } });
  assert.equal(likeComment.statusCode, 204);
  assert.equal((await ownerReacted()).length, 2);
  const commentInbox = await app.inject({ method: "GET", url: "/notifications", headers: ownerAuth });
  const likedComment = commentInbox.json<{ items: Array<{ reason: string; commentBody: string | null }> }>().items.find((item) => item.reason === "reacted" && item.commentBody);
  assert.equal(likedComment?.commentBody, "Shipped the new layout");
  assert.equal((await reactionEmails()).length, 2);
  const unlikeComment = await app.inject({ method: "DELETE", url: `/comments/${commentId}/reactions/thumbs_up`, headers: editorAuth });
  assert.equal(unlikeComment.statusCode, 204);
  assert.equal((await ownerReacted()).length, 1);
  // The audit rows are hidden: neither like shows up in the card's activity feed.
  const feed = await app.inject({ method: "GET", url: `/cards/${card!.id}/feed`, headers: ownerAuth });
  assert.doesNotMatch(feed.body, /reaction:added/);

  // Duplicating keeps the editor's thumbs-up on the copied file. The editor duplicates here, so the
  // copy is theirs: their own reaction must be dropped rather than left on their own upload.
  const ownerDuplicate = await app.inject({ method: "POST", url: `/cards/${card!.id}/duplicate`, headers: ownerAuth, payload: {} });
  assert.equal(ownerDuplicate.statusCode, 201, ownerDuplicate.body);
  const ownerCopy = await app.inject({ method: "GET", url: `/cards/${ownerDuplicate.json<{ id: string }>().id}/detail`, headers: ownerAuth });
  assert.deepEqual(ownerCopy.json<{ attachments: DetailAttachment[] }>().attachments[0]?.reactions?.map((r) => r.userIds), [[editor!.id]]);
  const editorDuplicate = await app.inject({ method: "POST", url: `/cards/${card!.id}/duplicate`, headers: editorAuth, payload: {} });
  assert.equal(editorDuplicate.statusCode, 201, editorDuplicate.body);
  const editorCopy = await app.inject({ method: "GET", url: `/cards/${editorDuplicate.json<{ id: string }>().id}/detail`, headers: ownerAuth });
  assert.deepEqual(editorCopy.json<{ attachments: DetailAttachment[] }>().attachments[0]?.reactions, []);

  const removed = await app.inject({ method: "DELETE", url: `/cards/${card!.id}/attachments/${attachment.id}`, headers: ownerAuth });
  assert.equal(removed.statusCode, 204);
  const leftover = await db.select().from(cardAttachmentReactions).where(eq(cardAttachmentReactions.attachmentId, attachment.id));
  assert.equal(leftover.length, 0, "reactions go with their attachment");

  await app.close();
});
