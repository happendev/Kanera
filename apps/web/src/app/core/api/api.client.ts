import { Injectable, InjectionToken, inject, untracked } from "@angular/core";
import { environment } from "../../../environments/environment";
import { AuthService } from "../auth/auth.service";
import { SocketService } from "../realtime/socket.service";

export const ORGANISATION_SWITCH_NAVIGATOR = new InjectionToken<() => void>("ORGANISATION_SWITCH_NAVIGATOR", {
  providedIn: "root",
  factory: () => () => window.location.assign(window.location.href),
});

@Injectable({ providedIn: "root" })
export class ApiClient {
  private readonly auth = inject(AuthService);
  private readonly sockets = inject(SocketService);
  private readonly reloadAfterOrganisationSwitch = inject(ORGANISATION_SWITCH_NAVIGATOR);

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
    if (res.status === 409) {
      const body = await res.clone().json().catch(() => null) as { code?: string; clientId?: string } | null;
      // Once the user has explicitly selected an organisation, requests from the old shell can race
      // its hard reload and return WRONG_ORG. They are stale work, not permission to reverse the
      // selection. A normal deep link still reaches this recovery path when no switch is pending.
      if (body?.code === "WRONG_ORG" && body.clientId && !this.auth.organisationSwitchPending()) {
        this.sockets.pauseForOrganisationSwitch();
        try {
          await this.auth.switchOrg(body.clientId);
          res = await doFetch(this.auth.getAccessToken());
        } finally {
          // The socket keeps its listeners and desired-room references, but reconnects with the new
          // token so no room from the prior organisation survives the handshake.
          this.sockets.resumeAfterOrganisationSwitch();
        }
        // The retry lets the deep-link request complete, while a same-URL reload tears down every
        // route-scoped store and rebuilds the active-org sidebar/cache from one coherent snapshot.
        this.reloadAfterOrganisationSwitch();
      }
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

    const send = (token: string | null): Promise<{ status: number; text: string }> => {
      if (opts.signal?.aborted) {
        return Promise.reject(new ApiError(0, { message: "Upload cancelled" }));
      }

      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        let settled = false;
        const progress = (event: ProgressEvent) => {
          if (event.lengthComputable) opts.onProgress?.(Math.round((event.loaded / event.total) * 100));
        };
        const cleanup = () => {
          opts.signal?.removeEventListener("abort", abortFromSignal);
          xhr.upload.removeEventListener("progress", progress);
        };
        const resolveOnce = (value: { status: number; text: string }) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        };
        const rejectOnce = (error: ApiError) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };
        const abortFromSignal = () => {
          xhr.abort();
          // Some XMLHttpRequest implementations do not emit `abort` before send(), so settle here
          // as well. rejectOnce keeps the subsequent browser abort event harmless.
          rejectOnce(new ApiError(0, { message: "Upload cancelled" }));
        };

        xhr.open("POST", `${environment.apiUrl}${path}`);
        xhr.withCredentials = true; // send the kanera_rt cookie, matching credentials: "include"
        if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
        // Intentionally do not set Content-Type: the browser must add the multipart boundary
        // itself (mirrors request()'s FormData branch, which skips the JSON Content-Type header).
        if (opts.onProgress) xhr.upload.addEventListener("progress", progress);
        xhr.addEventListener("load", () => resolveOnce({ status: xhr.status, text: xhr.responseText }), { once: true });
        xhr.addEventListener("error", () => rejectOnce(new ApiError(0, { message: "Upload failed" })), { once: true });
        xhr.addEventListener("abort", () => rejectOnce(new ApiError(0, { message: "Upload cancelled" })), { once: true });
        opts.signal?.addEventListener("abort", abortFromSignal, { once: true });
        xhr.send(form);
      });
    };

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
