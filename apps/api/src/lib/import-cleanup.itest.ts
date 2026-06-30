import "../test/setup.integration.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { kaneraBoardImports, trelloImports } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import { db } from "../db.js";
import { buildIntegrationServer } from "../test/integration.js";
import { runImportCleanup } from "./import-cleanup.js";
import { getStorageForClient } from "./storage/index.js";

const log = {
  info() { },
  error() { },
  warn() { },
} as never;

void test("import cleanup deletes sessions and source files older than 7 days", async () => {
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
    payload: { name: "Migration" },
  });
  assert.equal(created.statusCode, 201);
  const workspace = created.json<{ id: string }>();
  const storage = await getStorageForClient(user.clientId);

  const oldTrelloId = randomUUID();
  const oldKaneraId = randomUUID();
  const freshTrelloId = randomUUID();
  const oldTrelloKey = `imports/${oldTrelloId}/source.json`;
  const oldKaneraKey = `imports/kanera-board/${oldKaneraId}/source.json`;
  const freshTrelloKey = `imports/${freshTrelloId}/source.json`;
  await storage.put(oldTrelloKey, Buffer.from("{}"), "application/json");
  await storage.put(oldKaneraKey, Buffer.from("{}"), "application/json");
  await storage.put(freshTrelloKey, Buffer.from("{}"), "application/json");

  await db.insert(trelloImports).values([
    {
      id: oldTrelloId,
      workspaceId: workspace.id,
      clientId: user.clientId,
      createdById: user.id,
      status: "completed",
      sourceFileKey: oldTrelloKey,
      sourceFileName: "old-trello.json",
      manifest: {},
      source: {},
      createdAt: new Date("2026-06-01T00:00:00Z"),
      updatedAt: new Date("2026-06-01T00:00:00Z"),
    },
    {
      id: freshTrelloId,
      workspaceId: workspace.id,
      clientId: user.clientId,
      createdById: user.id,
      status: "ready",
      sourceFileKey: freshTrelloKey,
      sourceFileName: "fresh-trello.json",
      manifest: {},
      source: {},
      createdAt: new Date("2026-06-08T12:00:00Z"),
      updatedAt: new Date("2026-06-08T12:00:00Z"),
    },
  ]);
  await db.insert(kaneraBoardImports).values({
    id: oldKaneraId,
    workspaceId: workspace.id,
    clientId: user.clientId,
    createdById: user.id,
    status: "failed",
    sourceFileKey: oldKaneraKey,
    sourceFileName: "old-kanera.json",
    manifest: {},
    source: {},
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
  });

  const deleted = await runImportCleanup({ db, log }, new Date("2026-06-10T00:00:00Z"));
  assert.equal(deleted, 2);

  assert.equal((await db.select().from(trelloImports).where(eq(trelloImports.id, oldTrelloId))).length, 0);
  assert.equal((await db.select().from(kaneraBoardImports).where(eq(kaneraBoardImports.id, oldKaneraId))).length, 0);
  assert.equal((await db.select().from(trelloImports).where(eq(trelloImports.id, freshTrelloId))).length, 1);
  await assert.rejects(storage.get(oldTrelloKey));
  await assert.rejects(storage.get(oldKaneraKey));
  await assert.doesNotReject(storage.get(freshTrelloKey));
});
