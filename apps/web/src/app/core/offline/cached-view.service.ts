import { Injectable, inject, untracked } from "@angular/core";
import { ApiClient, ApiError } from "../api/api.client";
import { AuthService } from "../auth/auth.service";
import { SocketService } from "../realtime/socket.service";
import { OfflineCacheService } from "./offline-cache.service";

/** Read-only view queries share the bounded cache, scoped to the viewer, organisation and exact request. */
@Injectable({ providedIn: "root" })
export class CachedViewService {
  private readonly api = inject(ApiClient);
  private readonly auth = inject(AuthService);
  private readonly cache = inject(OfflineCacheService);
  readonly online = inject(SocketService).online;
  private readonly latestReads = new Map<string, symbol>();

  /** Persist a confirmed mutation response as the next read-only snapshot. */
  async remember(request: { url: string; body?: object }, response: unknown): Promise<void> {
    const user = untracked(() => this.auth.user());
    if (!user) return;
    const key = `${user.activeClientId ?? user.clientId}:${user.id}:${JSON.stringify(request)}`;
    this.latestReads.delete(key);
    await this.cache.saveViewQuery(key, response).catch(() => undefined);
  }

  async read<T>(request: { url: string; body?: object }, read = () => request.body
    ? this.api.post<T>(request.url, request.body)
    : this.api.get<T>(request.url)): Promise<{ response: T; cachedAt: string | null }> {
    const user = untracked(() => this.auth.user());
    const key = user ? `${user.activeClientId ?? user.clientId}:${user.id}:${JSON.stringify(request)}` : null;
    const token = Symbol();
    if (key) this.latestReads.set(key, token);
    try {
      if (!untracked(this.online)) throw new Error("offline");
      const response = await read();
      // Persistence failure must not turn a successful read into a stale offline response.
      // Realtime refreshes can overtake an earlier read. Only the newest request may replace the
      // persisted snapshot, just as the view's sequence guard protects its in-memory response.
      if (key && this.latestReads.get(key) === token) await this.cache.saveViewQuery(key, response).catch(() => undefined);
      return { response, cachedAt: null };
    } catch (error) {
      // A definite refusal must never resurrect previously accessible content.
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) throw error;
      const saved = key ? await this.cache.loadViewQuery(key).catch(() => null) : null;
      if (!saved) throw error;
      // The URL and complete body are part of the key, so this is the same endpoint's response type.
      return { response: saved.response as T, cachedAt: saved.cachedAt };
    } finally {
      if (key && this.latestReads.get(key) === token) this.latestReads.delete(key);
    }
  }
}
