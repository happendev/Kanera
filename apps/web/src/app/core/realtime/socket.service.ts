import { Injectable, InjectionToken, Injector, computed, effect, inject, signal } from "@angular/core";
import { Router } from "@angular/router";
import type { Socket } from "socket.io-client";
import { io } from "socket.io-client";
import { CLIENT_EVENTS, type ClientToServerEvents, type ServerToClientEvents } from "@kanera/shared/events";
import { AuthService } from "../auth/auth.service";
import { UpdatesService } from "../updates/updates.service";
import { environment } from "../../../environments/environment";

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
export const OFFLINE_DEBOUNCE_MS = 1500; // 1.5 seconds
export const SOCKET_IO = new InjectionToken<typeof io>("SOCKET_IO", {
  providedIn: "root",
  factory: () => io,
});

@Injectable({ providedIn: "root" })
export class SocketService {
  private readonly auth = inject(AuthService);
  private readonly injector = inject(Injector);
  private readonly socketFactory = inject(SOCKET_IO);
  private socket: AppSocket | null = null;
  private readonly workspaceRoomRefs = new Map<string, number>();
  private readonly joinedWorkspaceRooms = new Set<string>();
  private readonly boardRoomRefs = new Map<string, number>();
  private readonly joinedBoardRooms = new Set<string>();
  private readonly browserOnline = signal(typeof navigator === "undefined" ? true : navigator.onLine);

  readonly connected = signal(false);
  readonly reconnecting = signal(false);
  readonly accessRefreshing = signal(false);
  readonly lastDisconnectReason = signal<Socket.DisconnectReason | null>(null);
  private readonly connectionProblem = signal(false);
  readonly online = computed(() => this.browserOnline() && !this.connectionProblem());
  readonly displayedOnline = signal(true);

  constructor() {
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => this.browserOnline.set(true));
      window.addEventListener("offline", () => this.browserOnline.set(false));
    }

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible") return;
        // navigator.onLine's 'online' event is unreliable across suspend/resume (notably on
        // Linux/Chromium): resync directly from the API and nudge a stalled reconnect attempt
        // instead of waiting on socket.io's own backoff timer, which may itself be stale.
        this.browserOnline.set(navigator.onLine);
        if (navigator.onLine && this.socket && !this.socket.connected) this.socket.connect();
      });
    }

    effect((onCleanup) => {
      if (this.online()) {
        this.displayedOnline.set(true);
        return;
      }

      const timeout = setTimeout(() => {
        if (!this.online()) this.displayedOnline.set(false);
      }, OFFLINE_DEBOUNCE_MS);
      onCleanup(() => clearTimeout(timeout));
    });
  }

  connect(): AppSocket {
    if (this.socket) return this.socket;
    this.socket = this.socketFactory(environment.socketUrl, {
      autoConnect: true,
      withCredentials: true,
      transports: ["websocket"],
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      randomizationFactor: 0.5,
      auth: (cb) => cb({ token: this.auth.getAccessToken() ?? "" }),
    });
    const socket = this.socket;
    socket.on("connect", () => {
      const wasReconnecting = this.connectionProblem();
      this.connected.set(true);
      this.connectionProblem.set(false);
      this.reconnecting.set(false);
      this.lastDisconnectReason.set(null);
      if (wasReconnecting) void this.checkForAppUpdate();
      this.joinedWorkspaceRooms.clear();
      this.joinedBoardRooms.clear();
      for (const workspaceId of this.workspaceRoomRefs.keys()) {
        this.emitWorkspaceJoin(socket, workspaceId);
      }
      for (const boardId of this.boardRoomRefs.keys()) {
        this.emitBoardJoin(socket, boardId);
      }
    });
    socket.on("disconnect", (reason) => {
      this.connected.set(false);
      this.lastDisconnectReason.set(reason);
      if (reason === "io server disconnect") {
        void this.recoverFromServerEviction(socket);
        return;
      }
      this.connectionProblem.set(true);
    });
    this.socket.on("connect_error", async (err) => {
      this.connectionProblem.set(true);
      if (err.message === "unauthorized") {
        const fresh = await this.auth.refresh();
        if (fresh && this.socket === socket) socket.connect();
        else if (!this.auth.user()) await this.navigateToLogin();
      }
    });
    socket.io.on("reconnect_attempt", () => this.reconnecting.set(true));
    socket.io.on("reconnect_failed", () => this.reconnecting.set(false));
    return this.socket;
  }

  joinWorkspace(workspaceId: string): () => void {
    const currentCount = this.workspaceRoomRefs.get(workspaceId) ?? 0;
    if (currentCount === 0) {
      this.workspaceRoomRefs.set(workspaceId, 1);
      this.emitWorkspaceJoin(this.connect(), workspaceId);
    } else {
      this.workspaceRoomRefs.set(workspaceId, currentCount + 1);
      if (!this.joinedWorkspaceRooms.has(workspaceId)) this.emitWorkspaceJoin(this.connect(), workspaceId);
    }

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const count = this.workspaceRoomRefs.get(workspaceId) ?? 0;
      if (count > 1) {
        this.workspaceRoomRefs.set(workspaceId, count - 1);
        return;
      }
      this.workspaceRoomRefs.delete(workspaceId);
      this.joinedWorkspaceRooms.delete(workspaceId);
      this.socket?.emit(CLIENT_EVENTS.WORKSPACE_LEAVE, workspaceId);
    };
  }

  joinBoard(boardId: string): () => void {
    const currentCount = this.boardRoomRefs.get(boardId) ?? 0;
    if (currentCount === 0) {
      this.boardRoomRefs.set(boardId, 1);
      this.emitBoardJoin(this.connect(), boardId);
    } else {
      this.boardRoomRefs.set(boardId, currentCount + 1);
      if (!this.joinedBoardRooms.has(boardId)) this.emitBoardJoin(this.connect(), boardId);
    }

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const count = this.boardRoomRefs.get(boardId) ?? 0;
      if (count > 1) {
        this.boardRoomRefs.set(boardId, count - 1);
        return;
      }
      this.boardRoomRefs.delete(boardId);
      this.joinedBoardRooms.delete(boardId);
      this.socket?.emit(CLIENT_EVENTS.BOARD_LEAVE, boardId);
    };
  }

  private emitWorkspaceJoin(socket: AppSocket, workspaceId: string): void {
    if (this.joinedWorkspaceRooms.has(workspaceId)) return;
    this.joinedWorkspaceRooms.add(workspaceId);
    socket.emit(CLIENT_EVENTS.WORKSPACE_JOIN, workspaceId, (ok) => {
      if (!ok) this.joinedWorkspaceRooms.delete(workspaceId);
    });
  }

  private emitBoardJoin(socket: AppSocket, boardId: string): void {
    if (this.joinedBoardRooms.has(boardId)) return;
    this.joinedBoardRooms.add(boardId);
    socket.emit(CLIENT_EVENTS.BOARD_JOIN, boardId, (ok) => {
      if (!ok) this.joinedBoardRooms.delete(boardId);
    });
  }

  private async checkForAppUpdate(): Promise<void> {
    await this.injector.get(UpdatesService).checkForUpdate().catch(() => undefined);
  }

  private async recoverFromServerEviction(socket: AppSocket): Promise<void> {
    if (this.accessRefreshing()) return;
    this.accessRefreshing.set(true);
    try {
      // A server-side disconnect means access changed while this socket was live. Refresh the
      // session/user snapshot before reconnecting so stale JWT role claims or suspended accounts do
      // not strand the UI behind a generic offline message.
      const ok = await this.auth.reloadMe({ refreshToken: true });
      if (!ok) {
        if (!this.auth.user()) await this.navigateToLogin();
        else this.connectionProblem.set(true);
        return;
      }
      if (this.socket === socket) socket.connect();
    } finally {
      if (this.socket === socket) this.accessRefreshing.set(false);
    }
  }

  private async navigateToLogin(): Promise<void> {
    this.disconnect();
    await this.injector.get(Router).navigateByUrl("/login", { replaceUrl: true });
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
    this.workspaceRoomRefs.clear();
    this.joinedWorkspaceRooms.clear();
    this.boardRoomRefs.clear();
    this.joinedBoardRooms.clear();
    this.connected.set(false);
    this.connectionProblem.set(false);
    this.reconnecting.set(false);
    this.accessRefreshing.set(false);
  }
}
