import "../test/setup.integration.js";
import { boardMembers, boards, lists } from "@kanera/shared/schema";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { db } from "../db.js";
import { env } from "../env.js";
import { buildPublicApiServer } from "../public-api-server.js";
import { buildIntegrationServer, testUploadsDir } from "../test/integration.js";

// Hosted mode needs a license token, so E2E runs self-hosted and cannot reach the organisation MCP
// policy; these in-process tests are its only coverage. Failures they catch: a non-admin or an agent
// credential changing the policy; the policy being settable self-hosted; a read-only policy still
// letting a write-scoped credential write; an `off` organisation's boards and workspaces still
// discoverable or readable; a board guest from another organisation bypassing the data owner's
// policy; and a cap applied in one organisation sticking to the credential in another.

type SignupResponse = { accessToken: string; user: { id: string; clientId: string } };
type App = Awaited<ReturnType<typeof buildIntegrationServer>>;

async function withHosted<T>(fn: () => Promise<T>): Promise<T> {
  const previous = env.KANERA_DEPLOYMENT_MODE;
  env.KANERA_DEPLOYMENT_MODE = "hosted";
  try {
    return await fn();
  } finally {
    env.KANERA_DEPLOYMENT_MODE = previous;
  }
}

async function orgWithBoard(app: App, name: string) {
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { orgName: name, email: `owner-${randomUUID()}@example.com`, password: "Abc12345", displayName: "Owner" },
  });
  assert.equal(signup.statusCode, 200, signup.body);
  const { accessToken, user } = signup.json<SignupResponse>();
  const workspace = await app.inject({ method: "POST", url: "/workspaces", headers: { authorization: `Bearer ${accessToken}` }, payload: { name: `${name} workspace` } });
  assert.equal(workspace.statusCode, 201, workspace.body);
  const workspaceId = workspace.json<{ id: string }>().id;
  const [list] = await db.insert(lists).values({ workspaceId, name: "Todo", position: "1000.0000000000" }).returning();
  const [board] = await db.insert(boards).values({ workspaceId, name: `${name} board`, position: "1000.0000000000" }).returning();
  return { accessToken, user, workspaceId, listId: list!.id, boardId: board!.id };
}

async function setPolicy(app: App, token: string, mcpPolicy: "off" | "read" | "write") {
  const res = await app.inject({ method: "PATCH", url: "/clients/me", headers: { authorization: `Bearer ${token}` }, payload: { mcpPolicy } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json<{ mcpPolicy: string }>().mcpPolicy, mcpPolicy);
}

void test("organisation MCP policy caps personal agent credentials on the organisation's data", async () => {
  await withHosted(async () => {
    const app = await buildIntegrationServer();
    const publicApi = await buildPublicApiServer({ logger: false, rateLimit: { enabled: false }, uploadsDir: testUploadsDir("test-public-uploads") });
    try {
      const home = await orgWithBoard(app, "Policy Home");
      const host = await orgWithBoard(app, "Policy Host");
      // The home owner is also a guest editor on a board owned by the host organisation.
      await db.insert(boardMembers).values({ boardId: host.boardId, userId: home.user.id, role: "editor" });

      const keyRes = await app.inject({ method: "POST", url: "/me/api-keys", headers: { authorization: `Bearer ${home.accessToken}` }, payload: { label: "Agent", scope: "write" } });
      assert.equal(keyRes.statusCode, 201, keyRes.body);
      const bearer = { authorization: `Bearer ${keyRes.json<{ secret: string }>().secret}` };
      const createCard = (org: { boardId: string; listId: string }) => publicApi.inject({
        method: "POST",
        url: `/api/v1/boards/${org.boardId}/lists/${org.listId}/cards`,
        headers: bearer,
        payload: { title: "Written by an agent" },
      });
      const listBoards = async () => (await publicApi.inject({ method: "GET", url: "/api/v1/boards", headers: bearer })).body;

      assert.equal((await createCard(home)).statusCode, 201);
      assert.equal((await createCard(host)).statusCode, 201);

      // Read-only on the data owner: reads still work, writes are refused even though the key and
      // the guest's board role both allow them. The home organisation is unaffected in between.
      await setPolicy(app, host.accessToken, "read");
      const hostRead = await publicApi.inject({ method: "GET", url: `/api/v1/boards/${host.boardId}`, headers: bearer });
      assert.equal(hostRead.statusCode, 200, hostRead.body);
      assert.equal((await createCard(host)).statusCode, 403);
      assert.equal((await createCard(home)).statusCode, 201, "a cap in one organisation must not stick to the credential");
      assert.equal((await createCard(host)).statusCode, 403);

      // Off hides the organisation's boards from discovery and refuses direct access.
      await setPolicy(app, host.accessToken, "off");
      const blocked = await publicApi.inject({ method: "GET", url: `/api/v1/boards/${host.boardId}`, headers: bearer });
      assert.equal(blocked.statusCode, 403);
      assert.match(blocked.body, /AI agent access is turned off/);
      const listed = await listBoards();
      assert.ok(!listed.includes(host.boardId), "off organisation's board is not discoverable");
      assert.ok(listed.includes(home.boardId), "other organisations stay discoverable");

      // The home organisation turning itself off hides its own workspaces too.
      await setPolicy(app, home.accessToken, "off");
      const workspacesRes = await publicApi.inject({ method: "GET", url: "/api/v1/workspaces", headers: bearer });
      assert.equal(workspacesRes.statusCode, 200, workspacesRes.body);
      assert.ok(!workspacesRes.body.includes(home.workspaceId));
      assert.equal((await createCard(home)).statusCode, 403);
      // Org-scoped agent surfaces outside board access honour it too.
      assert.equal((await publicApi.inject({ method: "GET", url: "/api/v1/scratchpad/notes", headers: bearer })).statusCode, 403);
      const targets = await publicApi.inject({ method: "GET", url: "/api/v1/work/priority-targets", headers: bearer });
      assert.equal(targets.statusCode, 200, targets.body);
      assert.ok(!targets.body.includes(home.workspaceId), "off organisation's workspaces grant no priority targets");

      await setPolicy(app, home.accessToken, "write");
      await setPolicy(app, host.accessToken, "write");
      assert.equal((await createCard(host)).statusCode, 201);
      assert.equal((await createCard(home)).statusCode, 201);
    } finally {
      await publicApi.close();
    }
  });
});

void test("the MCP policy is settable only in hosted mode and only to a known value", async () => {
  const app = await buildIntegrationServer();
  const org = await orgWithBoard(app, "Policy Self Hosted");
  const auth = { authorization: `Bearer ${org.accessToken}` };
  const selfHosted = await app.inject({ method: "PATCH", url: "/clients/me", headers: auth, payload: { mcpPolicy: "off" } });
  assert.equal(selfHosted.statusCode, 400, selfHosted.body);
  const client = await app.inject({ method: "GET", url: "/clients/me", headers: auth });
  assert.equal(client.json<{ mcpPolicy: string }>().mcpPolicy, "write");

  await withHosted(async () => {
    const invalid = await app.inject({ method: "PATCH", url: "/clients/me", headers: auth, payload: { mcpPolicy: "admin" } });
    assert.equal(invalid.statusCode, 400, invalid.body);
    await setPolicy(app, org.accessToken, "read");
    const current = await app.inject({ method: "GET", url: "/clients/me", headers: auth });
    assert.equal(current.json<{ mcpPolicy: string }>().mcpPolicy, "read");
  });
});
