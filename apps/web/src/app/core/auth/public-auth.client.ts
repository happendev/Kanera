import { Injectable } from "@angular/core";
import { environment } from "../../../environments/environment";
import { appLocale } from "../i18n/locale";

/**
 * Transport for endpoints used before an authenticated ApiClient session exists. Keeping this
 * separate avoids an AuthService -> ApiClient cycle while centralising URL, cookie, and JSON rules.
 */
@Injectable({ providedIn: "root" })
export class PublicAuthClient {
  request(path: string, init: RequestInit = {}): Promise<Response> {
    // Signed-out flows (signup codes, password resets) are written in the language on screen.
    const headers = new Headers(init.headers);
    headers.set("Accept-Language", appLocale());
    return fetch(`${environment.apiUrl}${path}`, { ...init, headers, credentials: "include" });
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
