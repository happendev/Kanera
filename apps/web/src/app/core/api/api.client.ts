import { Injectable, inject, untracked } from "@angular/core";
import { environment } from "../../../environments/environment";
import { AuthService } from "../auth/auth.service";
import { SocketService } from "../realtime/socket.service";

@Injectable({ providedIn: "root" })
export class ApiClient {
  private readonly auth = inject(AuthService);
  private readonly sockets = inject(SocketService);

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const method = (init.method ?? "GET").toUpperCase();
    // Point-in-time connectivity guard. Read it untracked: request() is frequently called from
    // within reactive contexts (e.g. BoardPage's board-load effect calls loadBoard() synchronously),
    // and a tracked read would make those callers accidentally subscribe to connectivity. That
    // previously caused the whole board-load effect to re-run on every offline/online flip — which
    // called state.clear(), tearing down and rebuilding the board (lists, card detail) DOM.
    if (method !== "GET" && !untracked(() => this.sockets.displayedOnline())) {
      throw new ApiError(0, { message: "You're offline - changes are paused" });
    }

    const doFetch = async (token: string | null): Promise<Response> => {
      const headers = new Headers(init.headers);
      if (init.body && !(init.body instanceof FormData)) {
        headers.set("Content-Type", "application/json");
      }
      if (token) headers.set("Authorization", `Bearer ${token}`);
      return fetch(`${environment.apiUrl}${path}`, { ...init, headers, credentials: "include" });
    };

    let res = await doFetch(this.auth.getAccessToken());
    if (res.status === 401) {
      const fresh = await this.auth.refresh();
      if (fresh) res = await doFetch(fresh);
    }
    if (!res.ok) {
      const body: unknown = await res.json().catch(() => ({ message: res.statusText }));
      throw new ApiError(res.status, body);
    }
    if (res.status === 204) return undefined as T;
    const body: unknown = await res.json();
    return body as T;
  }

  /**
   * Multipart upload with byte-level progress. `request()` can't report upload progress because
   * fetch() exposes no upload-progress hook, so this path uses XMLHttpRequest instead. It mirrors
   * request()'s transport contract: offline guard, Bearer token, credentialed (cookie) requests,
   * one 401 -> auth.refresh() -> retry, and ApiError(status, body) on failure — so callers keep
   * using formatAttachmentUploadError (FILE_TOO_LARGE, STORAGE_QUOTA_EXCEEDED, 413, …) unchanged.
   */
  async upload<T>(
    path: string,
    form: FormData,
    opts: { onProgress?: (pct: number) => void; signal?: AbortSignal } = {},
  ): Promise<T> {
    // Same point-in-time, untracked connectivity guard as request() (see note there).
    if (!untracked(() => this.sockets.displayedOnline())) {
      throw new ApiError(0, { message: "You're offline - changes are paused" });
    }

    const send = (token: string | null): Promise<{ status: number; text: string }> =>
      new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${environment.apiUrl}${path}`);
        xhr.withCredentials = true; // send the kanera_rt cookie, matching credentials: "include"
        if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
        // Intentionally do not set Content-Type: the browser must add the multipart boundary
        // itself (mirrors request()'s FormData branch, which skips the JSON Content-Type header).
        if (opts.onProgress) {
          xhr.upload.addEventListener("progress", (e) => {
            if (e.lengthComputable) opts.onProgress!(Math.round((e.loaded / e.total) * 100));
          });
        }
        xhr.addEventListener("load", () => resolve({ status: xhr.status, text: xhr.responseText }));
        xhr.addEventListener("error", () => reject(new ApiError(0, { message: "Upload failed" })));
        xhr.addEventListener("abort", () => reject(new ApiError(0, { message: "Upload cancelled" })));
        if (opts.signal) {
          if (opts.signal.aborted) {
            xhr.abort();
            return;
          }
          opts.signal.addEventListener("abort", () => xhr.abort(), { once: true });
        }
        xhr.send(form);
      });

    let res = await send(this.auth.getAccessToken());
    if (res.status === 401) {
      const fresh = await this.auth.refresh();
      if (fresh) res = await send(fresh);
    }
    const parse = (text: string): unknown => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    };
    if (res.status < 200 || res.status >= 300) {
      throw new ApiError(res.status, parse(res.text) ?? { message: "Upload failed" });
    }
    return (parse(res.text) ?? undefined) as T;
  }

  get<T>(path: string) {
    return this.request<T>(path, { method: "GET" });
  }
  post<T>(path: string, body: unknown) {
    return this.request<T>(path, { method: "POST", body: JSON.stringify(body) });
  }
  async createCard<T>(path: string, body: Record<string, unknown> & { clientToken: string }): Promise<T> {
    const maxRetries = 2;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.post<T>(path, body);
      } catch (error) {
        const ambiguousFailure = error instanceof ApiError
          ? error.status === 0 || error.status >= 500
          : true;
        if (!ambiguousFailure || attempt >= maxRetries) throw error;
        // Retry decisions use the immediate transport-health signal rather than displayedOnline,
        // whose debounce intentionally avoids UI flicker during brief socket reconnects.
        if (!untracked(() => this.sockets.online())) throw error;

        // The stable client token makes an at-least-once retry safe when the server may have
        // committed the create before its response was lost. Never retry a definite 4xx rejection.
        await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
        // Connectivity can drop during the backoff; do not issue or consume another HTTP attempt
        // once the browser/socket health signal says the client is offline.
        if (!untracked(() => this.sockets.online())) throw error;
      }
    }
  }
  patch<T>(path: string, body: unknown) {
    return this.request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
  }
  put<T>(path: string, body: unknown) {
    return this.request<T>(path, { method: "PUT", body: JSON.stringify(body) });
  }
  delete<T>(path: string, body?: unknown) {
    return this.request<T>(path, {
      method: "DELETE",
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`api ${status}`);
  }
}
