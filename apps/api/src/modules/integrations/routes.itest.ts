import "../../test/setup.integration.js";
import { users, workspaceMembers } from "@kanera/shared/schema";
import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { buildIntegrationServer } from "../../test/integration.js";

type SignupResponse = { accessToken: string; user: { id: string; clientId: string } };
type WorkspaceResponse = { id: string };
type ApiKeyResponse = {
  id: string;
  createdById: string;
  createdByName: string;
  createdByEmail: string;
  name: string;
};

void test("workspace API key list includes keys created by other admins and their creator attribution", async () => {
  const app = await buildIntegrationServer();

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Acme Integrations",
      email: "integrations-owner@example.com",
      password: "Abc12345",
      displayName: "Owner User",
    },
  });
  assert.equal(signup.statusCode, 200);
  const { accessToken, user: owner } = signup.json<SignupResponse>();

  const workspaceCreated = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Delivery" },
  });
  assert.equal(workspaceCreated.statusCode, 201);
  const workspace = workspaceCreated.json<WorkspaceResponse>();

  const [teammate] = await db
    .insert(users)
    .values({
      clientId: owner.clientId,
      clientRole: "member",
      email: "integrations-admin@example.com",
      emailVerifiedAt: new Date(),
      passwordHash: "x",
      displayName: "Integration Admin",
    })
    .returning();
  assert.ok(teammate);
  await db.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: teammate.id, role: "admin" });

  const teammateToken = app.jwt.sign({ sub: teammate.id, cid: owner.clientId, role: "member" });
  const previousEnvironment = env.KANERA_ENVIRONMENT;
  env.KANERA_ENVIRONMENT = "staging";
  const created = await app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/api-keys`,
    headers: { authorization: `Bearer ${teammateToken}` },
    payload: { name: "Teammate sync", scope: "write" },
  });
  env.KANERA_ENVIRONMENT = previousEnvironment;
  assert.equal(created.statusCode, 201);
  const createdBody = created.json<ApiKeyResponse & { secret: string }>();
  assert.match(createdBody.secret, /^kanera_stg_/);
  assert.equal(createdBody.createdById, teammate.id);
  assert.equal(createdBody.createdByName, "Integration Admin");
  assert.equal(createdBody.createdByEmail, "integrations-admin@example.com");

  const listed = await app.inject({
    method: "GET",
    url: `/workspaces/${workspace.id}/api-keys`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(listed.statusCode, 200);
  const keys = listed.json<ApiKeyResponse[]>();
  assert.equal(keys.length, 1);
  assert.equal(keys[0]?.id, createdBody.id);
  assert.equal(keys[0]?.name, "Teammate sync");
  assert.equal(keys[0]?.createdById, teammate.id);
  assert.equal(keys[0]?.createdByName, "Integration Admin");
  assert.equal(keys[0]?.createdByEmail, "integrations-admin@example.com");
});
