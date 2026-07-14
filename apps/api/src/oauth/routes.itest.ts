import "../test/setup.integration.js";
import { cards, comments, lists } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { buildPublicApiServer } from "../public-api-server.js";
import { db } from "../db.js";
import { buildIntegrationServer } from "../test/integration.js";

function form(values: Record<string, string>) {
  return { headers: { "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams(values).toString() };
}

async function ownerFixture() {
  const app = await buildIntegrationServer();
  const signup = await app.inject({
    method: "POST", url: "/auth/signup",
    payload: { orgName: "Agent OAuth", email: "agent-oauth@example.com", password: "Abc12345", displayName: "Agent Owner" },
  });
  assert.equal(signup.statusCode, 200);
  const auth = signup.json<{ accessToken: string; user: { id: string } }>();
  const workspaceResponse = await app.inject({
    method: "POST", url: "/workspaces", headers: { authorization: `Bearer ${auth.accessToken}` }, payload: { name: "Agent workspace" },
  });
  assert.equal(workspaceResponse.statusCode, 201);
  return { app, accessToken: auth.accessToken, userId: auth.user.id, workspaceId: workspaceResponse.json<{ id: string }>().id };
}

void test("OAuth authorization-code, refresh rotation, and service client flows", async () => {
  const fixture = await ownerFixture();
  const publicApi = await buildPublicApiServer({ logger: false, rateLimit: { enabled: false } });
  try {
    const metadata = await publicApi.inject({ method: "GET", url: "/.well-known/oauth-authorization-server" });
    assert.equal(metadata.statusCode, 200);
    assert.equal(metadata.json<{ code_challenge_methods_supported: string[] }>().code_challenge_methods_supported[0], "S256");

    const registered = await publicApi.inject({
      method: "POST", url: "/oauth/register",
      payload: { client_name: "Test agent", redirect_uris: ["https://agent.example/callback"], grant_types: ["authorization_code", "refresh_token"], token_endpoint_auth_method: "none" },
    });
    assert.equal(registered.statusCode, 201);
    const clientId = registered.json<{ client_id: string }>().client_id;
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorization = {
      response_type: "code", client_id: clientId, redirect_uri: "https://agent.example/callback",
      code_challenge: challenge, code_challenge_method: "S256", scope: "kanera:read kanera:write offline_access", state: "test-state",
    };
    const context = await fixture.app.inject({ method: "GET", url: `/oauth/authorize/context?${new URLSearchParams(authorization).toString()}`, headers: { authorization: `Bearer ${fixture.accessToken}` } });
    assert.equal(context.statusCode, 200);
    assert.equal(context.json<{ clientName: string }>().clientName, "Test agent");

    const consent = await fixture.app.inject({ method: "POST", url: "/oauth/authorize/consent", headers: { authorization: `Bearer ${fixture.accessToken}` }, payload: authorization });
    assert.equal(consent.statusCode, 200);
    const redirect = new URL(consent.json<{ redirectUrl: string }>().redirectUrl);
    assert.equal(redirect.searchParams.get("state"), "test-state");
    const code = redirect.searchParams.get("code");
    assert.ok(code);

    const exchanged = await publicApi.inject({ method: "POST", url: "/oauth/token", ...form({ grant_type: "authorization_code", client_id: clientId, code, redirect_uri: authorization.redirect_uri, code_verifier: verifier }) });
    assert.equal(exchanged.statusCode, 200);
    const first = exchanged.json<{ access_token: string; refresh_token: string; expires_in: number }>();
    assert.match(first.access_token, /^kanera_oauth_/);
    assert.equal(first.expires_in, 900);

    const workspaceList = await publicApi.inject({ method: "GET", url: "/api/v1/workspaces", headers: { authorization: `Bearer ${first.access_token}` } });
    assert.equal(workspaceList.statusCode, 200);

    // Interactive write grants act as their owner. Keep the public-API permission checks as the
    // authority so an owner's live organisation/workspace admin role also governs MCP admin tools.
    const oauthWorkspaceCreated = await publicApi.inject({
      method: "POST",
      url: "/api/v1/workspaces",
      headers: { authorization: `Bearer ${first.access_token}` },
      payload: { name: "OAuth-created workspace" },
    });
    assert.equal(oauthWorkspaceCreated.statusCode, 201);

    const oauthBoardCreated = await publicApi.inject({
      method: "POST",
      url: `/api/v1/workspaces/${fixture.workspaceId}/boards`,
      headers: { authorization: `Bearer ${first.access_token}` },
      payload: { name: "OAuth admin board", description: "Managed by an agent" },
    });
    assert.equal(oauthBoardCreated.statusCode, 201);
    const oauthBoard = oauthBoardCreated.json<{ id: string }>();

    const oauthListCreated = await publicApi.inject({
      method: "POST",
      url: `/api/v1/workspaces/${fixture.workspaceId}/lists`,
      headers: { authorization: `Bearer ${first.access_token}` },
      payload: { name: "Agent queue" },
    });
    assert.equal(oauthListCreated.statusCode, 201);
    const oauthList = oauthListCreated.json<{ id: string }>();
    const oauthListRenamed = await publicApi.inject({
      method: "PATCH",
      url: `/api/v1/lists/${oauthList.id}`,
      headers: { authorization: `Bearer ${first.access_token}` },
      payload: { name: "Agent ready" },
    });
    assert.equal(oauthListRenamed.statusCode, 200);
    assert.equal(oauthListRenamed.json<{ name: string }>().name, "Agent ready");

    const oauthFieldCreated = await publicApi.inject({
      method: "POST",
      url: `/api/v1/workspaces/${fixture.workspaceId}/custom-fields`,
      headers: { authorization: `Bearer ${first.access_token}` },
      payload: { name: "Agent priority", type: "select", options: [{ label: "High" }] },
    });
    assert.equal(oauthFieldCreated.statusCode, 201);
    const oauthField = oauthFieldCreated.json<{ id: string }>();
    const oauthOptionCreated = await publicApi.inject({
      method: "POST",
      url: `/api/v1/custom-fields/${oauthField.id}/options`,
      headers: { authorization: `Bearer ${first.access_token}` },
      payload: { label: "Normal" },
    });
    assert.equal(oauthOptionCreated.statusCode, 201);

    const oauthLabelCreated = await publicApi.inject({
      method: "POST",
      url: `/api/v1/workspaces/${fixture.workspaceId}/card-labels`,
      headers: { authorization: `Bearer ${first.access_token}` },
      payload: { name: "Agent managed" },
    });
    assert.equal(oauthLabelCreated.statusCode, 201);

    const [list] = await db.select().from(lists).where(eq(lists.workspaceId, fixture.workspaceId)).limit(1);
    assert.ok(list);
    const [card] = await db.insert(cards).values({
      boardId: oauthBoard.id,
      listId: list.id,
      title: "Comment through OAuth",
      position: "1000.0000000000",
      createdById: fixture.userId,
    }).returning();
    assert.ok(card);
    const createdComment = await publicApi.inject({
      method: "POST",
      url: `/api/v1/cards/${card.id}/comments`,
      headers: { authorization: `Bearer ${first.access_token}` },
      payload: { body: "Comment from a personal OAuth connection" },
    });
    assert.equal(createdComment.statusCode, 201);
    const oauthComment = createdComment.json<{ id: string; authorKind: string; apiKeyId: string | null }>();
    assert.equal(oauthComment.authorKind, "user");
    assert.equal(oauthComment.apiKeyId, null);
    const [storedComment] = await db.select().from(comments).where(eq(comments.id, oauthComment.id)).limit(1);
    assert.equal(storedComment?.apiKeyId, null);

    const readVerifier = randomBytes(48).toString("base64url");
    const readAuthorization = {
      ...authorization,
      code_challenge: createHash("sha256").update(readVerifier).digest("base64url"),
      scope: "kanera:read",
      state: "read-only-state",
    };
    const readConsent = await fixture.app.inject({
      method: "POST",
      url: "/oauth/authorize/consent",
      headers: { authorization: `Bearer ${fixture.accessToken}` },
      payload: readAuthorization,
    });
    assert.equal(readConsent.statusCode, 200);
    const readCode = new URL(readConsent.json<{ redirectUrl: string }>().redirectUrl).searchParams.get("code");
    assert.ok(readCode);
    const readExchange = await publicApi.inject({
      method: "POST",
      url: "/oauth/token",
      ...form({ grant_type: "authorization_code", client_id: clientId, code: readCode, redirect_uri: authorization.redirect_uri, code_verifier: readVerifier }),
    });
    assert.equal(readExchange.statusCode, 200);
    const readToken = readExchange.json<{ access_token: string }>().access_token;
    const readAdminAttempt = await publicApi.inject({
      method: "POST",
      url: `/api/v1/workspaces/${fixture.workspaceId}/lists`,
      headers: { authorization: `Bearer ${readToken}` },
      payload: { name: "Must not be created" },
    });
    assert.equal(readAdminAttempt.statusCode, 403);

    const refreshed = await publicApi.inject({ method: "POST", url: "/oauth/token", ...form({ grant_type: "refresh_token", client_id: clientId, refresh_token: first.refresh_token }) });
    assert.equal(refreshed.statusCode, 200);
    const second = refreshed.json<{ refresh_token: string }>();
    assert.notEqual(second.refresh_token, first.refresh_token);
    const reused = await publicApi.inject({ method: "POST", url: "/oauth/token", ...form({ grant_type: "refresh_token", client_id: clientId, refresh_token: first.refresh_token }) });
    assert.equal(reused.statusCode, 401);

    const service = await fixture.app.inject({
      method: "POST", url: `/workspaces/${fixture.workspaceId}/agent-connections`, headers: { authorization: `Bearer ${fixture.accessToken}` }, payload: { name: "CI agent", scope: "write" },
    });
    assert.equal(service.statusCode, 201);
    const serviceCredential = service.json<{ clientId: string; clientSecret: string }>();
    const serviceToken = await publicApi.inject({
      method: "POST", url: "/oauth/token",
      ...form({ grant_type: "client_credentials", client_id: serviceCredential.clientId, client_secret: serviceCredential.clientSecret, scope: "kanera:write" }),
    });
    assert.equal(serviceToken.statusCode, 200);
    assert.match(serviceToken.json<{ access_token: string }>().access_token, /^kanera_oauth_/);
  } finally {
    await publicApi.close();
  }
});
