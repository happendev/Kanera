import "../../test/setup.integration.js";
import { clients, users } from "@kanera/shared/schema";
import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../../db.js";
import { buildIntegrationServer } from "../../test/integration.js";
import { verifyMediaToken } from "../../lib/media-signing.js";

async function seedClient(name: string, email: string) {
  const [client] = await db.insert(clients).values({ name }).returning();
  const [user] = await db
    .insert(users)
    .values({ clientId: client!.id, clientRole: "member", email, passwordHash: "x", displayName: name })
    .returning();
  return { client: client!, user: user! };
}

void test("/media/resign returns a fresh, verifiable URL for the caller's own media", async () => {
  const app = await buildIntegrationServer();
  const { client, user } = await seedClient("Acme", "a@example.com");
  const token = app.jwt.sign({ sub: user.id, cid: client.id, role: "member" });

  // A stale signed reference for this tenant's media (token/expiry irrelevant —
  // resign re-signs from the path alone).
  const key = "cards/card-1/image.jpg";
  const stale = `/api/media/${client.id}/cards/card-1/image.jpg?t=stale&e=1`;

  const res = await app.inject({
    method: "GET",
    url: `/media/resign?u=${encodeURIComponent(stale)}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);

  const { url } = res.json<{ url: string }>();
  const parsed = new URL(url);
  assert.equal(parsed.pathname, `/api/media/${client.id}/cards/card-1/image.jpg`);
  assert.equal(verifyMediaToken({
    clientId: client.id,
    key,
    t: parsed.searchParams.get("t")!,
    e: parsed.searchParams.get("e")!,
  }), true);
});

void test("/media/resign 404s for media belonging to a different tenant", async () => {
  const app = await buildIntegrationServer();
  const { client: caller, user } = await seedClient("Acme", "a@example.com");
  const { client: other } = await seedClient("Globex", "b@example.com");
  const token = app.jwt.sign({ sub: user.id, cid: caller.id, role: "member" });

  const foreign = `/api/media/${other.id}/cards/card-1/image.jpg?t=stale&e=1`;
  const res = await app.inject({
    method: "GET",
    url: `/media/resign?u=${encodeURIComponent(foreign)}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 404);
});

void test("/media/resign requires authentication", async () => {
  const app = await buildIntegrationServer();
  const { client } = await seedClient("Acme", "a@example.com");
  const reference = `/api/media/${client.id}/cards/card-1/image.jpg?t=stale&e=1`;
  const res = await app.inject({
    method: "GET",
    url: `/media/resign?u=${encodeURIComponent(reference)}`,
  });
  assert.equal(res.statusCode, 401);
});
