import "../test/setup.integration.js";
import { boards, cards, clientMembers, clients, comments, lists, workspaceMembers, workspaces } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { buildPublicApiServer } from "../public-api-server.js";
import { db } from "../db.js";
import { buildIntegrationServer } from "../test/integration.js";

const MCP_RESOURCE = "http://localhost:3002/mcp";

async function delegate(publicApi: Awaited<ReturnType<typeof buildPublicApiServer>>, accessToken: string) {
  const response = await publicApi.inject({
    method: "POST",
    url: "/oauth/mcp/delegate",
    headers: { "x-kanera-mcp-secret": process.env.MCP_INTERNAL_SECRET! },
    payload: { token: accessToken, resource: MCP_RESOURCE },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json<{ accessToken: string }>().accessToken;
}

function form(values: Record<string, string>) {
  return { headers: { "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams(values).toString() };
}

async function ownerFixture() {
  const app = await buildIntegrationServer();
  const suffix = randomUUID();
  const signup = await app.inject({
    method: "POST", url: "/auth/signup",
    payload: { orgName: `Agent OAuth ${suffix}`, email: `agent-oauth-${suffix}@example.com`, password: "Abc12345", displayName: "Agent Owner" },
  });
  assert.equal(signup.statusCode, 200);
  const auth = signup.json<{ accessToken: string; user: { id: string } }>();
  const workspaceResponse = await app.inject({
    method: "POST", url: "/workspaces", headers: { authorization: `Bearer ${auth.accessToken}` }, payload: { name: "Agent workspace" },
  });
  assert.equal(workspaceResponse.statusCode, 201);
  return { app, accessToken: auth.accessToken, userId: auth.user.id, workspaceId: workspaceResponse.json<{ id: string }>().id };
}

async function addSecondOrganisation(userId: string) {
  const [client] = await db.insert(clients).values({ name: "OAuth second organisation" }).returning();
  await db.insert(clientMembers).values({ clientId: client!.id, userId, clientRole: "owner" });
  const [workspace] = await db.insert(workspaces).values({
    clientId: client!.id,
    name: "OAuth second workspace",
    cardKeyPrefix: "OAUTHB",
  }).returning();
  await db.insert(workspaceMembers).values({ workspaceId: workspace!.id, userId, role: "admin" });
  const [list] = await db.insert(lists).values({ workspaceId: workspace!.id, name: "Queue", position: "1000.0000000000" }).returning();
  const [board] = await db.insert(boards).values({ workspaceId: workspace!.id, name: "OAuth second board", position: "1000.0000000000" }).returning();
  const [card] = await db.insert(cards).values({
    boardId: board!.id,
    listId: list!.id,
    title: "OAuth cross-organisation card",
    position: "1000.0000000000",
    createdById: userId,
  }).returning();
  return { client: client!, workspace: workspace!, card: card! };
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

    const missingResource = await fixture.app.inject({
      method: "GET",
      url: `/oauth/authorize/context?${new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: "https://agent.example/callback",
        code_challenge: "x".repeat(43),
        code_challenge_method: "S256",
      }).toString()}`,
      headers: { authorization: `Bearer ${fixture.accessToken}` },
    });
    assert.equal(missingResource.statusCode, 400, "authorization requests require an MCP resource");
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorization = {
      response_type: "code", client_id: clientId, redirect_uri: "https://agent.example/callback",
      code_challenge: challenge, code_challenge_method: "S256", scope: "kanera:read kanera:write offline_access", state: "test-state", resource: MCP_RESOURCE,
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

    const mismatchedExchange = await publicApi.inject({
      method: "POST",
      url: "/oauth/token",
      ...form({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        redirect_uri: authorization.redirect_uri,
        code_verifier: verifier,
        resource: "https://agent.example/not-kanera",
      }),
    });
    assert.equal(mismatchedExchange.statusCode, 400);
    assert.equal(mismatchedExchange.json<{ error: string }>().error, "invalid_target");

    const exchanged = await publicApi.inject({ method: "POST", url: "/oauth/token", ...form({ grant_type: "authorization_code", client_id: clientId, code, redirect_uri: authorization.redirect_uri, code_verifier: verifier, resource: MCP_RESOURCE }) });
    assert.equal(exchanged.statusCode, 200);
    const first = exchanged.json<{ access_token: string; refresh_token: string; expires_in: number }>();
    assert.match(first.access_token, /^kanera_mcp_/);
    assert.equal(first.expires_in, 900);

    const directWorkspaceList = await publicApi.inject({ method: "GET", url: "/api/v1/workspaces", headers: { authorization: `Bearer ${first.access_token}` } });
    assert.equal(directWorkspaceList.statusCode, 401, "MCP-audience token is not a public API bearer token");
    const delegatedAccessToken = await delegate(publicApi, first.access_token);
    const secondOrganisation = await addSecondOrganisation(fixture.userId);
    const workspaceList = await publicApi.inject({ method: "GET", url: "/api/v1/workspaces", headers: { authorization: `Bearer ${delegatedAccessToken}` } });
    assert.equal(workspaceList.statusCode, 200);
    assert.ok(workspaceList.json<Array<{ id: string }>>().some((workspace) => workspace.id === secondOrganisation.workspace.id));

    const crossOrganisationUpdate = await publicApi.inject({
      method: "PATCH",
      url: `/api/v1/cards/${secondOrganisation.card.id}`,
      headers: { authorization: `Bearer ${delegatedAccessToken}` },
      payload: { title: "Updated through the same MCP authorization" },
    });
    assert.equal(crossOrganisationUpdate.statusCode, 200, crossOrganisationUpdate.body);

    // Interactive write grants act as their owner. Keep the public-API permission checks as the
    // authority so an owner's live organisation/workspace admin role also governs MCP admin tools.
    const oauthWorkspaceCreated = await publicApi.inject({
      method: "POST",
      url: "/api/v1/workspaces",
      headers: { authorization: `Bearer ${delegatedAccessToken}` },
      payload: { name: "OAuth-created workspace" },
    });
    assert.equal(oauthWorkspaceCreated.statusCode, 201);

    const oauthBoardCreated = await publicApi.inject({
      method: "POST",
      url: `/api/v1/workspaces/${fixture.workspaceId}/boards`,
      headers: { authorization: `Bearer ${delegatedAccessToken}` },
      payload: { name: "OAuth admin board", description: "Managed by an agent" },
    });
    assert.equal(oauthBoardCreated.statusCode, 201);
    const oauthBoard = oauthBoardCreated.json<{ id: string }>();

    const oauthListCreated = await publicApi.inject({
      method: "POST",
      url: `/api/v1/workspaces/${fixture.workspaceId}/lists`,
      headers: { authorization: `Bearer ${delegatedAccessToken}` },
      payload: { name: "Agent queue" },
    });
    assert.equal(oauthListCreated.statusCode, 201);
    const oauthList = oauthListCreated.json<{ id: string }>();
    const oauthListRenamed = await publicApi.inject({
      method: "PATCH",
      url: `/api/v1/lists/${oauthList.id}`,
      headers: { authorization: `Bearer ${delegatedAccessToken}` },
      payload: { name: "Agent ready" },
    });
    assert.equal(oauthListRenamed.statusCode, 200);
    assert.equal(oauthListRenamed.json<{ name: string }>().name, "Agent ready");

    const oauthFieldCreated = await publicApi.inject({
      method: "POST",
      url: `/api/v1/workspaces/${fixture.workspaceId}/custom-fields`,
      headers: { authorization: `Bearer ${delegatedAccessToken}` },
      payload: { name: "Agent priority", type: "select", options: [{ label: "High" }] },
    });
    assert.equal(oauthFieldCreated.statusCode, 201);
    const oauthField = oauthFieldCreated.json<{ id: string }>();
    const oauthOptionCreated = await publicApi.inject({
      method: "POST",
      url: `/api/v1/custom-fields/${oauthField.id}/options`,
      headers: { authorization: `Bearer ${delegatedAccessToken}` },
      payload: { label: "Normal" },
    });
    assert.equal(oauthOptionCreated.statusCode, 201);

    const oauthLabelCreated = await publicApi.inject({
      method: "POST",
      url: `/api/v1/workspaces/${fixture.workspaceId}/card-labels`,
      headers: { authorization: `Bearer ${delegatedAccessToken}` },
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
      headers: { authorization: `Bearer ${delegatedAccessToken}` },
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
      ...form({ grant_type: "authorization_code", client_id: clientId, code: readCode, redirect_uri: authorization.redirect_uri, code_verifier: readVerifier, resource: MCP_RESOURCE }),
    });
    assert.equal(readExchange.statusCode, 200);
    const readToken = readExchange.json<{ access_token: string }>().access_token;
    const readDelegation = await delegate(publicApi, readToken);
    const readAdminAttempt = await publicApi.inject({
      method: "POST",
      url: `/api/v1/workspaces/${fixture.workspaceId}/lists`,
      headers: { authorization: `Bearer ${readDelegation}` },
      payload: { name: "Must not be created" },
    });
    assert.equal(readAdminAttempt.statusCode, 403);

    const refreshed = await publicApi.inject({ method: "POST", url: "/oauth/token", ...form({ grant_type: "refresh_token", client_id: clientId, refresh_token: first.refresh_token, resource: MCP_RESOURCE }) });
    assert.equal(refreshed.statusCode, 200);
    const second = refreshed.json<{ refresh_token: string }>();
    assert.notEqual(second.refresh_token, first.refresh_token);
    const reused = await publicApi.inject({ method: "POST", url: "/oauth/token", ...form({ grant_type: "refresh_token", client_id: clientId, refresh_token: first.refresh_token, resource: MCP_RESOURCE }) });
    assert.equal(reused.statusCode, 401);

    const service = await fixture.app.inject({
      method: "POST", url: `/workspaces/${fixture.workspaceId}/agent-connections`, headers: { authorization: `Bearer ${fixture.accessToken}` }, payload: { name: "CI agent", scope: "write" },
    });
    assert.equal(service.statusCode, 201);
    const serviceCredential = service.json<{ clientId: string; clientSecret: string }>();
    const serviceToken = await publicApi.inject({
      method: "POST", url: "/oauth/token",
      ...form({ grant_type: "client_credentials", client_id: serviceCredential.clientId, client_secret: serviceCredential.clientSecret, scope: "kanera:write", resource: MCP_RESOURCE }),
    });
    assert.equal(serviceToken.statusCode, 200);
    const serviceAccessToken = serviceToken.json<{ access_token: string }>().access_token;
    assert.match(serviceAccessToken, /^kanera_mcp_/);
    const serviceDelegation = await delegate(publicApi, serviceAccessToken);
    const pinnedWorkspaceUpdate = await publicApi.inject({
      method: "PATCH",
      url: `/api/v1/cards/${card.id}`,
      headers: { authorization: `Bearer ${serviceDelegation}` },
      payload: { title: "Updated by the pinned service connection" },
    });
    assert.equal(pinnedWorkspaceUpdate.statusCode, 200, pinnedWorkspaceUpdate.body);
    const serviceCrossOrganisationAttempt = await publicApi.inject({
      method: "PATCH",
      url: `/api/v1/cards/${secondOrganisation.card.id}`,
      headers: { authorization: `Bearer ${serviceDelegation}` },
      payload: { title: "Must remain unchanged" },
    });
    assert.equal(serviceCrossOrganisationAttempt.statusCode, 403, serviceCrossOrganisationAttempt.body);
  } finally {
    await Promise.all([publicApi.close(), fixture.app.close()]);
  }
});

void test("OAuth device authorization supports polling, approval, replay protection, and denial", async () => {
  const fixture = await ownerFixture();
  const publicApi = await buildPublicApiServer({ logger: false, rateLimit: { enabled: false } });
  const deviceGrant = "urn:ietf:params:oauth:grant-type:device_code";
  try {
    const metadata = await publicApi.inject({ method: "GET", url: "/.well-known/oauth-authorization-server" });
    assert.equal(metadata.statusCode, 200);
    const discovery = metadata.json<{ device_authorization_endpoint: string; grant_types_supported: string[] }>();
    assert.equal(discovery.device_authorization_endpoint.endsWith("/oauth/device/code"), true);
    assert.equal(discovery.grant_types_supported.includes(deviceGrant), true);

    const registered = await publicApi.inject({
      method: "POST",
      url: "/oauth/register",
      payload: {
        client_name: "Headless test agent",
        grant_types: [deviceGrant, "refresh_token"],
        token_endpoint_auth_method: "none",
      },
    });
    assert.equal(registered.statusCode, 201, registered.body);
    const registration = registered.json<{ client_id: string; redirect_uris: string[] }>();
    assert.deepEqual(registration.redirect_uris, []);

    const issued = await publicApi.inject({
      method: "POST",
      url: "/oauth/device/code",
      payload: {
        client_id: registration.client_id,
        scope: "kanera:read kanera:write offline_access",
        resource: MCP_RESOURCE,
      },
    });
    assert.equal(issued.statusCode, 200, issued.body);
    const request = issued.json<{
      device_code: string;
      user_code: string;
      verification_uri: string;
      verification_uri_complete: string;
      expires_in: number;
      interval: number;
    }>();
    assert.match(request.device_code, /^kanera_device_/);
    assert.match(request.user_code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(request.expires_in, 600);
    assert.equal(new URL(request.verification_uri_complete).searchParams.get("user_code"), request.user_code);

    const poll = () => publicApi.inject({
      method: "POST",
      url: "/oauth/token",
      ...form({ grant_type: deviceGrant, device_code: request.device_code, client_id: registration.client_id, resource: MCP_RESOURCE }),
    });
    const pending = await poll();
    assert.equal(pending.statusCode, 400);
    assert.equal(pending.json<{ error: string }>().error, "authorization_pending");
    const tooFast = await poll();
    assert.equal(tooFast.statusCode, 400);
    assert.equal(tooFast.json<{ error: string }>().error, "slow_down");

    const context = await fixture.app.inject({
      method: "GET",
      url: `/oauth/device/context?${new URLSearchParams({ user_code: request.user_code }).toString()}`,
      headers: { authorization: `Bearer ${fixture.accessToken}` },
    });
    assert.equal(context.statusCode, 200, context.body);
    assert.equal(context.json<{ clientName: string }>().clientName, "Headless test agent");

    const approved = await fixture.app.inject({
      method: "POST",
      url: "/oauth/device/consent",
      headers: { authorization: `Bearer ${fixture.accessToken}` },
      payload: { user_code: request.user_code, decision: "approve" },
    });
    assert.equal(approved.statusCode, 200, approved.body);
    assert.equal(approved.json<{ approved: boolean }>().approved, true);

    const exchanged = await poll();
    assert.equal(exchanged.statusCode, 200, exchanged.body);
    const tokens = exchanged.json<{ access_token: string; refresh_token: string; expires_in: number }>();
    assert.match(tokens.access_token, /^kanera_mcp_/);
    assert.match(tokens.refresh_token, /^kanera_refresh_/);
    assert.equal(tokens.expires_in, 900);
    const directWorkspaceList = await publicApi.inject({
      method: "GET",
      url: "/api/v1/workspaces",
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    assert.equal(directWorkspaceList.statusCode, 401);
    const delegatedAccessToken = await delegate(publicApi, tokens.access_token);
    const workspaceList = await publicApi.inject({
      method: "GET",
      url: "/api/v1/workspaces",
      headers: { authorization: `Bearer ${delegatedAccessToken}` },
    });
    assert.equal(workspaceList.statusCode, 200);

    const replay = await poll();
    assert.equal(replay.statusCode, 400);
    assert.equal(replay.json<{ error: string }>().error, "expired_token");

    const deniedIssue = await publicApi.inject({
      method: "POST",
      url: "/oauth/device/code",
      payload: { client_id: registration.client_id, scope: "kanera:read", resource: MCP_RESOURCE },
    });
    assert.equal(deniedIssue.statusCode, 200);
    const deniedRequest = deniedIssue.json<{ device_code: string; user_code: string }>();
    const denied = await fixture.app.inject({
      method: "POST",
      url: "/oauth/device/consent",
      headers: { authorization: `Bearer ${fixture.accessToken}` },
      payload: { user_code: deniedRequest.user_code, decision: "deny" },
    });
    assert.equal(denied.statusCode, 200, denied.body);
    const deniedPoll = await publicApi.inject({
      method: "POST",
      url: "/oauth/token",
      ...form({ grant_type: deviceGrant, device_code: deniedRequest.device_code, client_id: registration.client_id, resource: MCP_RESOURCE }),
    });
    assert.equal(deniedPoll.statusCode, 400);
    assert.equal(deniedPoll.json<{ error: string }>().error, "access_denied");
  } finally {
    await Promise.all([publicApi.close(), fixture.app.close()]);
  }
});
