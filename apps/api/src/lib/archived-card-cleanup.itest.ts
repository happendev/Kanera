import "../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { boards, cardAttachments, cards, lists } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import { db } from "../db.js";
import { buildIntegrationServer } from "../test/integration.js";
import { runArchivedCardCleanup } from "./archived-card-cleanup.js";
import { getStorageForClient } from "./storage/index.js";

const log = {
  info() { },
  error() { },
  warn() { },
} as never;

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

test("archived card cleanup deletes the row, its attachment rows, and the storage files", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { orgName: "Acme", email: "owner@example.com", password: "Abc12345", displayName: "Owner" },
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
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Roadmap", position: "1000.0000000000" })
    .returning();
  const [card] = await db
    .insert(cards)
    .values({ listId: list!.id, boardId: board!.id, title: "Has attachment", position: "1000.0000000000", createdById: user.id })
    .returning();

  const upload = await app.inject({
    method: "POST",
    url: `/cards/${card!.id}/attachments?source=description`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: svgForm("inline.svg"),
  });
  assert.equal(upload.statusCode, 201);

  const [attachment] = await db.select().from(cardAttachments).where(eq(cardAttachments.cardId, card!.id));
  assert.ok(attachment, "attachment row should exist before cleanup");
  const storage = await getStorageForClient(user.clientId);
  // File exists before cleanup.
  await assert.doesNotReject(storage.get(attachment!.fileKey));

  // Archive the card well past the 30-day retention window so the sweep claims it.
  await db.update(cards).set({ archivedAt: new Date("2020-01-01T00:00:00Z") }).where(eq(cards.id, card!.id));

  const deleted = await runArchivedCardCleanup({ db, log });
  assert.equal(deleted, 1);

  // Row and its cascaded attachment row are gone, and so is the physical file.
  const remainingCards = await db.select().from(cards).where(eq(cards.id, card!.id));
  assert.equal(remainingCards.length, 0);
  const remainingAttachments = await db.select().from(cardAttachments).where(eq(cardAttachments.cardId, card!.id));
  assert.equal(remainingAttachments.length, 0);
  await assert.rejects(storage.get(attachment!.fileKey), "storage file should be deleted");
});
