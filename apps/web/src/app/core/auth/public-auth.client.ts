import { Injectable } from "@angular/core";
import { environment } from "../../../environments/environment";

/**
 * Transport for endpoints used before an authenticated ApiClient session exists. Keeping this
 * separate avoids an AuthService -> ApiClient cycle while centralising URL, cookie, and JSON rules.
 */
@Injectable({ providedIn: "root" })
export class PublicAuthClient {
  request(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${environment.apiUrl}${path}`, { ...init, credentials: "include" });
  }

  get(path: string): Promise<Response> {
    return this.request(path);
  }

  post(path: string, body: unknown): Promise<Response> {
    return this.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
}
