import { Injectable, inject } from "@angular/core";
import { environment } from "../../../environments/environment";
import { AdminAuthService } from "../auth/admin-auth.service";

// Fetch wrapper mirroring the tenant ApiClient's transport contract (Bearer token, credentialed cookie
// requests, one 401 -> refresh -> retry, ApiError on failure) minus the socket/offline machinery.
@Injectable({ providedIn: "root" })
export class ApiClient {
  private readonly auth = inject(AdminAuthService);

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const doFetch = async (token: string | null): Promise<Response> => {
      const headers = new Headers(init.headers);
      if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
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
    return (await res.json()) as T;
  }

  get<T>(path: string) {
    return this.request<T>(path, { method: "GET" });
  }
  post<T>(path: string, body?: unknown) {
    return this.request<T>(path, { method: "POST", ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  }
  patch<T>(path: string, body: unknown) {
    return this.request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
  }
  delete<T>(path: string) {
    return this.request<T>(path, { method: "DELETE" });
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`api ${status}`);
  }

  get serverMessage(): string {
    if (this.body && typeof this.body === "object" && "message" in this.body) {
      return String((this.body as { message: unknown }).message);
    }
    return `Request failed (${this.status})`;
  }
}
