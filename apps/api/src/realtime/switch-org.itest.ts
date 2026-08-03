import "../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { io as connect, type Socket } from "socket.io-client";
import { clientMembers, clients, workspaceMembers, workspaces } from "@kanera/shared/schema";
import { db } from "../db.js";
import { buildIntegrationServer } from "../test/integration.js";
import { emitClientEntitlementsChanged } from "./emit.js";

type Session = { accessToken: string; user: { id: string; clientId: string } };

async function connectSocket(url: string, token: string): Promise<Socket> {
  const socket = connect(url, { auth: { token }, reconnection: false, transports: ["websocket"] });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("socket connect timed out")), 2_000);
    socket.once("connect", () => { clearTimeout(timeout); resolve(socket); });
    socket.once("connect_error", (error) => { clearTimeout(timeout); reject(error); });
  });
}

function waitForDisconnect(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("socket disconnect timed out")), 2_000);
    socket.once("disconnect", (reason) => { clearTimeout(timeout); resolve(reason); });
  });
}

function joinWorkspace(socket: Socket, workspaceId: string): Promise<boolean> {
  return new Promise((resolve) => socket.emit("workspace:join", workspaceId, resolve));
}

function nextEntitlementEvent(socket: Socket): Promise<{ clientId: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("entitlement event timed out")), 2_000);
    socket.once("client:entitlements:changed", (payload: unknown) => {
      clearTimeout(timeout);
      const candidate = payload as { clientId?: unknown };
      if (typeof candidate.clientId !== "string") {
        reject(new Error("invalid entitlement event payload"));
        return;
      }
      resolve({ clientId: candidate.clientId });
    });
  });
}

function noEntitlementEvent(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("client:entitlements:changed", handler);
      resolve();
    }, 150);
    function handler() {
      clearTimeout(timeout);
      reject(new Error("received an event from the old organisation room"));
    }
    socket.once("client:entitlements:changed", handler);
  });
}

void test("switching evicts the old socket and reconnects into only the new organisation rooms", async () => {
  const app = await buildIntegrationServer({ enableRealtime: true });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  const url = `http://127.0.0.1:${address.port}`;

  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { orgName: "Socket Org A", email: "socket-switch@example.com", password: "Abc12345", displayName: "Socket Switcher" },
  });
  assert.equal(signup.statusCode, 200, signup.body);
  const initial = signup.json<Session>();
  const [orgB] = await db.insert(clients).values({ name: "Socket Org B" }).returning();
  await db.insert(clientMembers).values({ clientId: orgB!.id, userId: initial.user.id, clientRole: "member" });
  const [workspaceA, workspaceB] = await db.insert(workspaces).values([
    { clientId: initial.user.clientId, name: "Socket workspace A" },
    { clientId: orgB!.id, name: "Socket workspace B" },
  ]).returning();
  await db.insert(workspaceMembers).values([
    { workspaceId: workspaceA!.id, userId: initial.user.id, role: "member" },
    { workspaceId: workspaceB!.id, userId: initial.user.id, role: "member" },
  ]);

  const oldSocket = await connectSocket(url, initial.accessToken);
  const disconnected = waitForDisconnect(oldSocket);
  const switched = await app.inject({
    method: "POST",
    url: "/auth/switch-org",
    headers: { authorization: `Bearer ${initial.accessToken}` },
    payload: { clientId: orgB!.id },
  });
  assert.equal(switched.statusCode, 200, switched.body);
  assert.equal(await disconnected, "io server disconnect");

  const newSocket = await connectSocket(url, switched.json<Session>().accessToken);
  try {
    assert.equal(await joinWorkspace(newSocket, workspaceA!.id), false);
    assert.equal(await joinWorkspace(newSocket, workspaceB!.id), true);
    const newOrgEvent = nextEntitlementEvent(newSocket);
    emitClientEntitlementsChanged(orgB!.id);
    assert.equal((await newOrgEvent).clientId, orgB!.id);
    const oldOrgLeak = noEntitlementEvent(newSocket);
    emitClientEntitlementsChanged(initial.user.clientId);
    await oldOrgLeak;
  } finally {
    newSocket.close();
  }
});
