import { Injectable, inject, signal } from "@angular/core";
import { SocketService } from "./socket.service";

@Injectable({ providedIn: "root" })
export class PresenceService {
  private readonly sockets = inject(SocketService);
  private readonly onlineByWorkspace = signal(new Map<string, Set<string>>());
  private readonly lastOnlineAtByWorkspace = signal(new Map<string, Map<string, string | Date>>());
  private readonly watchedWorkspaces = new Map<string, { count: number; leave: () => void }>();
  private listening = false;

  isOnline(workspaceId: string | null | undefined, userId: string | null | undefined): boolean {
    if (!workspaceId || !userId) return false;
    return Boolean(this.onlineByWorkspace().get(workspaceId)?.has(userId));
  }

  lastOnlineAt(workspaceId: string | null | undefined, userId: string | null | undefined): string | Date | null {
    if (!workspaceId || !userId) return null;
    return this.lastOnlineAtByWorkspace().get(workspaceId)?.get(userId) ?? null;
  }

  watchWorkspace(workspaceId: string): () => void {
    this.ensureListening();
    const watched = this.watchedWorkspaces.get(workspaceId);
    if (watched) {
      watched.count += 1;
    } else {
      // Join after listeners are installed so presence-enabled avatars always
      // get a fresh snapshot, even if the page joined the room earlier.
      this.watchedWorkspaces.set(workspaceId, { count: 1, leave: this.sockets.joinWorkspace(workspaceId) });
    }

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const current = this.watchedWorkspaces.get(workspaceId);
      if (!current) return;
      if (current.count > 1) {
        current.count -= 1;
        return;
      }
      current.leave();
      this.watchedWorkspaces.delete(workspaceId);
    };
  }

  private ensureListening(): void {
    if (this.listening) return;
    this.listening = true;
    // Keep socket setup lazy so plain avatars do not connect realtime presence.
    // The first opted-in k-avatar installs the shared listeners for the app.
    const socket = this.sockets.connect();
    socket.on("presence:snapshot", ({ workspaceId, onlineUserIds }) => {
      this.onlineByWorkspace.update((current) => {
        const next = new Map(current);
        next.set(workspaceId, new Set(onlineUserIds));
        return next;
      });
    });
    socket.on("presence:changed", ({ workspaceId, userId, online, lastOnlineAt }) => {
      this.onlineByWorkspace.update((current) => {
        const next = new Map(current);
        const users = new Set(next.get(workspaceId) ?? []);
        if (online) users.add(userId);
        else users.delete(userId);
        next.set(workspaceId, users);
        return next;
      });
      if (!online && lastOnlineAt) {
        this.lastOnlineAtByWorkspace.update((current) => {
          const next = new Map(current);
          const workspace = new Map(next.get(workspaceId) ?? []);
          workspace.set(userId, lastOnlineAt);
          next.set(workspaceId, workspace);
          return next;
        });
      }
    });
  }
}
