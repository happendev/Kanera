import "../test/setup.integration.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { io as connect, type Socket } from "socket.io-client";
import { boardMembers, boards, users, workspaceMembers } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import { db } from "../db.js";
import { buildIntegrationServer } from "../test/integration.js";

type SignupResponse = { accessToken: string; user: { id: string; clientId: string } };

async function listenWithRealtime() {
  const app = await buildIntegrationServer({ enableRealtime: true });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
  return { app, url: `http://127.0.0.1:${address.port}` };
}

async function signupOwner(app: Awaited<ReturnType<typeof listenWithRealtime>>["app"], email: string): Promise<SignupResponse> {
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      orgName: "Realtime Test",
      email,
      password: "Abc12345",
      displayName: "Owner",
    },
  });
  assert.equal(signup.statusCode, 200);
  return signup.json<SignupResponse>();
}

async function createWorkspace(app: Awaited<ReturnType<typeof listenWithRealtime>>["app"], accessToken: string): Promise<{ id: string }> {
  const created = await app.inject({
    method: "POST",
    url: "/workspaces",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { name: "Realtime" },
  });
  assert.equal(created.statusCode, 201);
  return created.json<{ id: string }>();
}

function connectSocket(url: string, token: string): Promise<Socket> {
  const socket = connect(url, {
    auth: { token },
    reconnection: false,
    transports: ["websocket"],
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("socket connect timed out")), 2_000);
    socket.once("connect", () => {
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.once("connect_error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function expectConnectError(url: string, token: string): Promise<void> {
  const socket = connect(url, {
    auth: { token },
    reconnection: false,
    transports: ["websocket"],
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("socket connect_error timed out"));
    }, 2_000);
    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.close();
      reject(new Error("socket unexpectedly connected"));
    });
    socket.once("connect_error", () => {
      clearTimeout(timeout);
      socket.close();
      resolve();
    });
  });
}

function waitForDisconnect(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("socket disconnect timed out")), 2_000);
    socket.once("disconnect", (reason) => {
      clearTimeout(timeout);
      resolve(reason);
    });
  });
}

function emitWorkspaceJoin(socket: Socket, workspaceId: string): Promise<boolean> {
  return new Promise((resolve) => {
    socket.emit("workspace:join", workspaceId, resolve);
  });
}

function nextPresenceSnapshot(socket: Socket, workspaceId: string): Promise<{ onlineUserIds: string[] }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("presence snapshot timed out")), 2_000);
    socket.on("presence:snapshot", function handler(payload: { workspaceId: string; onlineUserIds: string[] }) {
      if (payload.workspaceId !== workspaceId) return;
      clearTimeout(timeout);
      socket.off("presence:snapshot", handler);
      resolve({ onlineUserIds: payload.onlineUserIds });
    });
  });
}

function nextPresenceChange(socket: Socket, workspaceId: string, userId: string, online: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("presence change timed out")), 2_000);
    socket.on("presence:changed", function handler(payload: { workspaceId: string; userId: string; online: boolean }) {
      if (payload.workspaceId !== workspaceId || payload.userId !== userId || payload.online !== online) return;
      clearTimeout(timeout);
      socket.off("presence:changed", handler);
      resolve();
    });
  });
}

void test("workspace member removal disconnects the user's live sockets", async () => {
  const { app, url } = await listenWithRealtime();
  const owner = await signupOwner(app, "socket-evict-owner@example.com");
  const workspace = await createWorkspace(app, owner.accessToken);
  const [member] = await db
    .insert(users)
    .values({
      clientId: owner.user.clientId,
      clientRole: "member",
      email: "socket-evict-member@example.com",
      passwordHash: "x",
      displayName: "Member",
    })
    .returning();
  assert.ok(member);
  await db.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: member.id, role: "editor" });

  const memberToken = app.jwt.sign({ sub: member.id, cid: owner.user.clientId, role: "member" });
  const socket = await connectSocket(url, memberToken);
  const disconnected = waitForDisconnect(socket);

  const removed = await app.inject({
    method: "DELETE",
    url: `/workspaces/${workspace.id}/members/${member.id}`,
    headers: { authorization: `Bearer ${owner.accessToken}` },
  });
  assert.equal(removed.statusCode, 204);
  assert.equal(await disconnected, "io server disconnect");
});

void test("socket handshake uses the current org role instead of stale JWT role claims", async () => {
  const { app, url } = await listenWithRealtime();
  const owner = await signupOwner(app, "socket-stale-role-owner@example.com");
  const workspace = await createWorkspace(app, owner.accessToken);
  const [member] = await db
    .insert(users)
    .values({
      clientId: owner.user.clientId,
      clientRole: "member",
      email: "socket-stale-role-member@example.com",
      passwordHash: "x",
      displayName: "Member",
    })
    .returning();
  assert.ok(member);

  const staleOwnerToken = app.jwt.sign({ sub: member.id, cid: owner.user.clientId, role: "owner" });
  const socket = await connectSocket(url, staleOwnerToken);
  try {
    assert.equal(await emitWorkspaceJoin(socket, workspace.id), false);
  } finally {
    socket.close();
  }
});

void test("cross-org board guests can join workspace presence without joining workspace event rooms", async () => {
  const { app, url } = await listenWithRealtime();
  const owner = await signupOwner(app, "socket-guest-presence-owner@example.com");
  const workspace = await createWorkspace(app, owner.accessToken);
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Guest board", position: "1000.0000000000", visibility: "workspace" })
    .returning();
  assert.ok(board);
  const guest = await signupOwner(app, "socket-guest-presence-guest@external.test");
  assert.notEqual(guest.user.clientId, owner.user.clientId);
  const outsider = await signupOwner(app, "socket-guest-presence-outsider@external.test");
  assert.notEqual(outsider.user.clientId, owner.user.clientId);
  await db.insert(boardMembers).values({ boardId: board.id, userId: guest.user.id, role: "editor" });

  const ownerSocket = await connectSocket(url, owner.accessToken);
  const guestSocket = await connectSocket(url, guest.accessToken);
  const outsiderSocket = await connectSocket(url, outsider.accessToken);
  try {
    const ownerSnapshot = nextPresenceSnapshot(ownerSocket, workspace.id);
    assert.equal(await emitWorkspaceJoin(ownerSocket, workspace.id), true);
    assert.ok((await ownerSnapshot).onlineUserIds.includes(owner.user.id));

    const guestChanged = nextPresenceChange(ownerSocket, workspace.id, guest.user.id, true);
    const guestSnapshot = nextPresenceSnapshot(guestSocket, workspace.id);
    assert.equal(await emitWorkspaceJoin(guestSocket, workspace.id), true);
    assert.ok((await guestSnapshot).onlineUserIds.includes(guest.user.id));
    await guestChanged;

    assert.equal(await emitWorkspaceJoin(outsiderSocket, workspace.id), false);

    const leakedWorkspaceEvent = new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        guestSocket.off("board:created", handler);
        resolve(false);
      }, 150);
      function handler() {
        clearTimeout(timeout);
        resolve(true);
      }
      guestSocket.once("board:created", handler);
    });
    const created = await app.inject({
      method: "POST",
      url: `/workspaces/${workspace.id}/boards`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: "Workspace-only event", visibility: "workspace" },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(await leakedWorkspaceEvent, false);
  } finally {
    ownerSocket.close();
    guestSocket.close();
    outsiderSocket.close();
  }
});

void test("private board guest presence snapshot excludes unrelated workspace members", async () => {
  const { app, url } = await listenWithRealtime();
  const owner = await signupOwner(app, "socket-private-guest-presence-owner@example.com");
  const workspace = await createWorkspace(app, owner.accessToken);
  const [board] = await db
    .insert(boards)
    .values({ workspaceId: workspace.id, name: "Private guest board", position: "1000.0000000000", visibility: "private" })
    .returning();
  assert.ok(board);
  const [hiddenMember] = await db
    .insert(users)
    .values({
      clientId: owner.user.clientId,
      clientRole: "member",
      email: "socket-private-guest-hidden@example.com",
      passwordHash: "x",
      displayName: "Hidden Member",
    })
    .returning();
  assert.ok(hiddenMember);
  await db.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: hiddenMember.id, role: "editor" });

  const guest = await signupOwner(app, "socket-private-guest-presence-guest@external.test");
  await db.insert(boardMembers).values([
    { boardId: board.id, userId: owner.user.id, role: "owner" },
    { boardId: board.id, userId: guest.user.id, role: "editor" },
  ]);

  const ownerSocket = await connectSocket(url, owner.accessToken);
  const hiddenToken = app.jwt.sign({ sub: hiddenMember.id, cid: owner.user.clientId, role: "member" });
  const hiddenSocket = await connectSocket(url, hiddenToken);
  const guestSocket = await connectSocket(url, guest.accessToken);
  try {
    const ownerSnapshot = nextPresenceSnapshot(ownerSocket, workspace.id);
    assert.equal(await emitWorkspaceJoin(ownerSocket, workspace.id), true);
    await ownerSnapshot;

    const hiddenSnapshot = nextPresenceSnapshot(hiddenSocket, workspace.id);
    assert.equal(await emitWorkspaceJoin(hiddenSocket, workspace.id), true);
    await hiddenSnapshot;

    const guestSnapshot = nextPresenceSnapshot(guestSocket, workspace.id);
    assert.equal(await emitWorkspaceJoin(guestSocket, workspace.id), true);
    const onlineUserIds = (await guestSnapshot).onlineUserIds;
    assert.ok(onlineUserIds.includes(guest.user.id));
    assert.ok(onlineUserIds.includes(owner.user.id));
    assert.equal(onlineUserIds.includes(hiddenMember.id), false);
  } finally {
    ownerSocket.close();
    hiddenSocket.close();
    guestSocket.close();
  }
});

void test("socket handshake rejects suspended users", async () => {
  const { app, url } = await listenWithRealtime();
  const owner = await signupOwner(app, "socket-suspended-owner@example.com");
  const [member] = await db
    .insert(users)
    .values({
      clientId: owner.user.clientId,
      clientRole: "member",
      email: "socket-suspended-member@example.com",
      passwordHash: "x",
      displayName: "Suspended",
      suspendedAt: new Date(),
    })
    .returning();
  assert.ok(member);

  const token = app.jwt.sign({ sub: member.id, cid: owner.user.clientId, role: "member" });
  await expectConnectError(url, token);

  const [stillSuspended] = await db.select({ suspendedAt: users.suspendedAt }).from(users).where(eq(users.id, member.id));
  assert.ok(stillSuspended?.suspendedAt);
});
