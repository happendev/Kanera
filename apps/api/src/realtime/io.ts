import type { FastifyInstance } from "fastify";
import { createAdapter } from "@socket.io/redis-adapter";
import { Server } from "socket.io";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { CLIENT_EVENTS, SERVER_EVENTS, type ClientToServerEvents, type ServerToClientEvents } from "@kanera/shared/events";
import { boardMembers, boards, users, workspaceMembers, workspaces, type ClientRole } from "@kanera/shared/schema";
import { db } from "../db.js";
import { env } from "../env.js";
import type { AuthClaims } from "../auth/plugin.js";
import { assertBoardAccess, isOrgAdmin } from "../lib/access.js";
import { setRealtimeMetricsLogger } from "./metrics.js";
import { PresenceTracker } from "./presence.js";
import { createAdapterPair } from "../redis.js";
import { broadcastPresenceToWorkspace } from "./broadcast.js";

export type IoServer = Server<ClientToServerEvents, ServerToClientEvents, never, SocketData>;
interface SocketData {
  userId: string;
  clientId: string;
  role: ClientRole;
}

function claimsFromSocket(data: SocketData): AuthClaims {
  return { sub: data.userId, cid: data.clientId, role: data.role };
}

let io: IoServer | null = null;
let presence: PresenceTracker | null = null;
let closeAdapterPair: (() => Promise<void>) | null = null;

export async function recordPresenceOffline(event: Parameters<ServerToClientEvents["presence:changed"]>[0]): Promise<Parameters<ServerToClientEvents["presence:changed"]>[0]> {
  if (event.online) return event;
  const lastOnlineAt = new Date();
  await db.update(users).set({ lastOnlineAt, updatedAt: lastOnlineAt }).where(eq(users.id, event.userId));
  return { ...event, lastOnlineAt: lastOnlineAt.toISOString() };
}

export function getIo(): IoServer {
  if (!io) throw new Error("io not initialised");
  return io;
}

export function maybeGetIo(): IoServer | null {
  return io;
}

export function disconnectUserRealtimeSockets(userId: string): void {
  const server = maybeGetIo();
  if (!server) return;
  // Existing sockets keep their joined rooms and handshake claims until a reconnect. Force any
  // access-sensitive membership or role change through the normal handshake/join authorization path.
  for (const socket of server.sockets.sockets.values()) {
    if (socket.data.userId === userId) socket.disconnect(true);
  }
  void server.fetchSockets()
    .then((sockets) => {
      for (const socket of sockets) {
        if (socket.data.userId === userId) socket.disconnect(true);
      }
    })
    .catch(() => {
      server.in(`user:${userId}`).disconnectSockets(true);
    });
}

export async function closeRealtimeIo(): Promise<void> {
  const server = io;
  const activePresence = presence;
  const closeAdapter = closeAdapterPair;
  io = null;
  presence = null;
  closeAdapterPair = null;

  if (server && activePresence) {
    const events = await activePresence.close();
    for (const event of events) {
      const payload = await recordPresenceOffline(event);
      server.to(`workspace:${payload.workspaceId}`).emit(SERVER_EVENTS.PRESENCE_CHANGED, payload);
    }
  } else {
    await activePresence?.close();
  }

  await Promise.allSettled([
    closeAdapter?.(),
    new Promise<void>((resolve) => {
      if (!server) return resolve();
      // Broadcast-only servers (worker, public API) are created via `new Server()` with no
      // attached HTTP server, so socket.io never initialises an engine. Calling close() on
      // such a server throws on `this.engine.close()`. The adapter pair is torn down
      // separately above, so there is nothing else to close — just resolve.
      const hasEngine = Boolean((server as unknown as { engine?: unknown }).engine);
      if (!hasEngine) return resolve();
      void server.close(() => resolve());
    }),
  ]);
}

export async function setupIo(app: FastifyInstance): Promise<IoServer> {
  setRealtimeMetricsLogger(app.log);
  await closeRealtimeIo();
  presence = new PresenceTracker();
  await presence.startHeartbeat();
  io = new Server(app.server, {
    cors: { origin: env.WEB_ORIGIN, credentials: true },
    transports: ["websocket"],
    // Kanera only enables websocket transport, so per-message deflate is the compression path that
    // shrinks realtime frames. Keep a threshold so tiny presence/move events do not burn CPU.
    perMessageDeflate: env.REALTIME_WEBSOCKET_COMPRESSION_ENABLED
      ? { threshold: env.REALTIME_WEBSOCKET_COMPRESSION_THRESHOLD_BYTES }
      : false,
    // Client→server traffic is only room join/leave (a UUID plus an ack); see
    // ClientToServerEvents in @kanera/shared/events. Cap the per-message buffer well below the
    // 1MB default so a misbehaving or malicious client cannot make the engine buffer large frames.
    maxHttpBufferSize: 1e4,
  });
  const adapterPair = await createAdapterPair();
  closeAdapterPair = adapterPair.close;
  io.adapter(createAdapter(adapterPair.pubClient, adapterPair.subClient));
  app.addHook("onClose", async () => {
    await closeRealtimeIo();
  });

  io.engine.on("connection", (rawSocket) => {
    (rawSocket as { request: unknown }).request = null;
  });

  io.use((socket, next) => {
    const token = (socket.handshake.auth as { token?: string } | undefined)?.token;
    if (!token) return next(new Error("unauthorized"));
    void (async () => {
      let claims: AuthClaims;
      try {
        claims = app.jwt.verify<AuthClaims>(token);
      } catch {
        return next(new Error("unauthorized"));
      }
      const [currentUser] = await db
        .select({ role: users.clientRole })
        .from(users)
        .where(and(eq(users.id, claims.sub), eq(users.clientId, claims.cid), isNull(users.suspendedAt), isNull(users.removedAt)))
        .limit(1);
      if (!currentUser) return next(new Error("unauthorized"));
      socket.data.userId = claims.sub;
      socket.data.clientId = claims.cid;
      socket.data.role = currentUser.role;
      next();
    })().catch(() => next(new Error("unauthorized")));
  });

  io.on("connection", (socket) => {
    const claims = claimsFromSocket(socket.data);
    let disconnected = false;
    void socket.join(`client:${socket.data.clientId}`);
    void socket.join(`user:${socket.data.userId}`);

    void (isOrgAdmin(claims)
      ? db
          .select({ workspaceId: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.clientId, socket.data.clientId))
      : db
          .select({ workspaceId: workspaceMembers.workspaceId })
          .from(workspaceMembers)
          .where(eq(workspaceMembers.userId, socket.data.userId))
    )
      // The initial workspace lookup is async; the socket may disconnect before
      // it resolves. Guard both before and after join so a late callback cannot
      // leave stale online presence behind.
      .then(async (rows) => {
        for (const row of rows) {
          if (disconnected) break;
          await socket.join(`workspace:${row.workspaceId}`);
          if (disconnected) break;
          const event = await presence?.markOnline(row.workspaceId, socket.data.userId, socket.id);
          if (disconnected) break;
          if (event) broadcastPresenceToWorkspace(row.workspaceId, event);
        }
        // The socket can disconnect while markOnline's Valkey writes are in flight. markOnline only
        // populates the in-memory socket→workspaces map after those awaits, so the disconnect
        // handler's removeSocket can run first, find nothing, and leave the user stuck online in the
        // shared presence hash until this process dies. Undo here once the late callback has settled.
        if (disconnected) {
          const offlineEvents = (await presence?.removeSocket(socket.id, socket.data.userId)) ?? [];
          for (const event of offlineEvents) {
            const payload = await recordPresenceOffline(event);
            broadcastPresenceToWorkspace(payload.workspaceId, payload);
          }
        }
      })
      .catch((err: unknown) => app.log.warn({ err, socketId: socket.id }, "failed to join socket workspace rooms"));

    // Join only board rooms for explicit cross-org guests. Workspace rooms carry
    // host-org events that board guests must not receive.
    void db
      .select({ boardId: boardMembers.boardId })
      .from(boardMembers)
      .innerJoin(boards, eq(boards.id, boardMembers.boardId))
      .innerJoin(
        workspaces,
        and(eq(workspaces.id, boards.workspaceId), ne(workspaces.clientId, socket.data.clientId)),
      )
      .where(eq(boardMembers.userId, socket.data.userId))
      .then(async (rows) => {
        for (const row of rows) {
          if (disconnected) return;
          await socket.join(`board:${row.boardId}`);
        }
      })
      .catch((err: unknown) => app.log.warn({ err, socketId: socket.id }, "failed to join socket cross-org board rooms"));

    socket.on(CLIENT_EVENTS.BOARD_JOIN, async (boardId, ack) => {
      try {
        await assertBoardAccess(claims, boardId);
      } catch {
        return ack(false);
      }
      await socket.join(`board:${boardId}`);
      ack(true);
    });

    socket.on(CLIENT_EVENTS.BOARD_LEAVE, async (boardId) => {
      await socket.leave(`board:${boardId}`);
    });

    socket.on(CLIENT_EVENTS.WORKSPACE_JOIN, async (workspaceId, ack) => {
      if (isOrgAdmin(claims)) {
        const [ws] = await db
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(and(eq(workspaces.id, workspaceId), eq(workspaces.clientId, socket.data.clientId)))
          .limit(1);
        if (ws) {
          await joinWorkspaceRoom(workspaceId);
          socket.emit(SERVER_EVENTS.PRESENCE_SNAPSHOT, { workspaceId, onlineUserIds: await presence!.onlineUserIds(workspaceId) });
          return ack(true);
        }
      }
      const [member] = await db
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, socket.data.userId)))
        .limit(1);
      if (!member) {
        const guestBoards = await db
          .select({ boardId: boards.id })
          .from(boardMembers)
          .innerJoin(boards, eq(boards.id, boardMembers.boardId))
          .where(and(eq(boards.workspaceId, workspaceId), eq(boardMembers.userId, socket.data.userId)))
        if (guestBoards.length === 0) return ack(false);
        // Board guests need workspace-scoped presence for avatars, but not the workspace
        // event stream. Do not join a workspace-wide room; send a filtered snapshot and
        // rely on board-room fanout for future visible presence changes.
        await joinWorkspaceRoom(workspaceId, { includeWorkspaceEvents: false });
        socket.emit(SERVER_EVENTS.PRESENCE_SNAPSHOT, {
          workspaceId,
          onlineUserIds: await visibleGuestOnlineUserIds(workspaceId, guestBoards),
        });
        return ack(true);
      }
      await joinWorkspaceRoom(workspaceId);
      socket.emit(SERVER_EVENTS.PRESENCE_SNAPSHOT, { workspaceId, onlineUserIds: await presence!.onlineUserIds(workspaceId) });
      ack(true);
    });

    socket.on(CLIENT_EVENTS.WORKSPACE_LEAVE, async (workspaceId) => {
      await socket.leave(`workspace:${workspaceId}`);
      const event = await presence?.markOffline(workspaceId, socket.data.userId, socket.id);
      if (event) {
        const payload = await recordPresenceOffline(event);
        broadcastPresenceToWorkspace(workspaceId, payload);
      }
    });

    socket.on("disconnect", () => {
      disconnected = true;
      void presence?.removeSocket(socket.id, socket.data.userId)
        .then(async (events) => {
          for (const event of events) {
            const payload = await recordPresenceOffline(event);
            broadcastPresenceToWorkspace(payload.workspaceId, payload);
          }
        })
        .catch((err: unknown) => app.log.warn({ err, socketId: socket.id }, "failed to clear socket presence"));
    });

    async function joinWorkspaceRoom(workspaceId: string, options: { includeWorkspaceEvents?: boolean } = {}): Promise<void> {
      if (options.includeWorkspaceEvents !== false) await socket.join(`workspace:${workspaceId}`);
      const event = await presence?.markOnline(workspaceId, socket.data.userId, socket.id);
      if (event) broadcastPresenceToWorkspace(workspaceId, event);
    }

    async function visibleGuestOnlineUserIds(
      workspaceId: string,
      guestBoards: { boardId: string }[],
    ): Promise<string[]> {
      const visibleUserIds = new Set<string>([socket.data.userId]);
      const boardIds = guestBoards.map((board) => board.boardId);
      // A cross-org guest may only see the presence of users who share one of their boards. Board
      // membership is the access model, so visible users are exactly the union of those boards'
      // members — never the full workspace roster (which a guest cannot see).
      const explicitBoardUsers = boardIds.length > 0
        ? await db.select({ userId: boardMembers.userId }).from(boardMembers).where(inArray(boardMembers.boardId, boardIds))
        : [];
      for (const row of explicitBoardUsers) visibleUserIds.add(row.userId);

      return (await presence!.onlineUserIds(workspaceId)).filter((userId) => visibleUserIds.has(userId));
    }
  });

  return io;
}

export async function setupBroadcastIo(): Promise<IoServer> {
  await closeRealtimeIo();
  io = new Server<ClientToServerEvents, ServerToClientEvents, never, SocketData>();
  const adapterPair = await createAdapterPair();
  closeAdapterPair = adapterPair.close;
  io.adapter(createAdapter(adapterPair.pubClient, adapterPair.subClient));
  return io;
}
