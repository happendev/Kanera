import { outboundHttpClient } from "../../lib/outbound-http.js";

/** Trello's authenticated download route may redirect to a short-lived public file URL. */
export async function downloadTrelloAttachment(url: string, authorization: string, maxBytes: number): Promise<Response> {
  const origin = new URL(url).origin;
  const signal = AbortSignal.timeout(30_000);
  let target = new URL(url);
  let maySendCredentials = true;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    // This is the only redirect-capable integration transport. Every hop is
    // resolved, checked as public HTTPS and pinned independently. OAuth must
    // never follow a capability URL onto another origin, even if it redirects back.
    const response = await outboundHttpClient.fetch(target, {
      redirect: "manual", signal,
      headers: maySendCredentials && target.origin === origin ? { Authorization: authorization } : {},
    }, { policy: "public", maxResponseBytes: maxBytes, timeoutMs: 30_000 });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location || redirects === 3) throw new Error("invalid attachment redirect");
    const next = new URL(location, target);
    maySendCredentials &&= next.origin === origin;
    target = next;
  }
  throw new Error("invalid attachment redirect");
}
