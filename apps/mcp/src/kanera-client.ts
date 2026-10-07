import { createHash } from "node:crypto";

/**
 * Stable, non-reversible identity for a credential, used to scope per-process caches and telemetry
 * so nothing resolved for one credential is ever served to another.
 */
export function credentialDigest(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("base64url").slice(0, 22);
}

export class KaneraApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfter?: string | null,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Phase a request belongs to, so latency can be split into card resolution and the tool's own work. */
export type UpstreamPhase = "card_resolution" | "api";

export interface UpstreamTiming {
  method: string;
  /** Path with UUIDs, card keys, and organisation keys templated, so it is safe as a metric label. */
  route: string;
  status: number;
  phase: UpstreamPhase;
  /** Round trip measured by MCP: network, proxy, and public API time together. */
  durationMs: number;
  /** Handler time the public API reported in Server-Timing, when present. */
  appMs: number | null;
}

export interface KaneraClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  idempotencyKey?: string;
  onUpstreamRequest?: (timing: UpstreamTiming) => void;
}

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const CARD_KEY_SEGMENT = /^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]*$/iu;
const ORGANISATION_KEY_SEGMENT = /^[A-F0-9]{16}$/iu;

function upstreamRouteTemplate(pathname: string): string {
  return pathname.split("/").map((segment) => {
    if (UUID_SEGMENT.test(segment)) return ":id";
    if (CARD_KEY_SEGMENT.test(segment)) return ":cardKey";
    if (ORGANISATION_KEY_SEGMENT.test(segment)) return ":organisationKey";
    return segment;
  }).join("/");
}

function serverTimingAppMs(header: string | null): number | null {
  const match = header?.match(/(?:^|,)\s*app;dur=([0-9.]+)/u);
  return match ? Number(match[1]) : null;
}

export class KaneraClient {
  private readonly baseUrl: URL;
  private readonly fetchImpl: typeof fetch;
  private phaseDepth = 0;
  private digest: string | null = null;

  constructor(private readonly options: KaneraClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Labels requests started while `work` runs as card resolution, so per-call timing can separate
   * key/URL lookup from the tool's own requests. Tool handlers await resolution before their main
   * request, so a depth counter is sufficient without async-context tracking.
   */
  get credentialScope(): string {
    return (this.digest ??= credentialDigest(this.options.apiKey));
  }

  async resolvingCards<T>(work: () => Promise<T>): Promise<T> {
    this.phaseDepth += 1;
    try {
      return await work();
    } finally {
      this.phaseDepth -= 1;
    }
  }

  async get<T>(path: string, query?: Record<string, string | number | boolean | null | undefined>): Promise<T> {
    return this.request<T>("GET", path, undefined, query);
  }

  async post<T>(path: string, body?: unknown, query?: Record<string, string | number | boolean | null | undefined>): Promise<T> {
    return this.request<T>("POST", path, body, query);
  }

  async patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }

  async put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PUT", path, body);
  }

  async delete<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }

  async upload<T>(
    path: string,
    file: { fileName: string; mimeType: string; bytes: Uint8Array },
    query?: Record<string, string | number | boolean | null | undefined>,
  ): Promise<T> {
    const url = this.url(path, query);
    const form = new FormData();
    // Copy into an ArrayBuffer-backed view: BlobPart excludes SharedArrayBuffer even though the
    // caller's generic Uint8Array may be typed as ArrayBufferLike.
    const bytes = new Uint8Array(file.bytes.byteLength);
    bytes.set(file.bytes);
    form.append("file", new Blob([bytes.buffer], { type: file.mimeType }), file.fileName);
    return this.timed("POST", url, () => this.fetchResponse(url, {
      method: "POST",
      headers: this.headers(),
      body: form,
      signal: this.signal(),
    }));
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | null | undefined>,
  ): Promise<T> {
    const url = this.url(path, query);
    return this.timed(method, url, () => this.fetchResponse(url, {
      method,
      headers: this.headers(body !== undefined, method !== "GET"),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: this.signal(),
    }));
  }

  private async timed<T>(method: string, url: URL, send: () => Promise<Response>): Promise<T> {
    const phase: UpstreamPhase = this.phaseDepth > 0 ? "card_resolution" : "api";
    const startedAt = performance.now();
    let status = 0;
    let appMs: number | null = null;
    try {
      const response = await send();
      status = response.status;
      appMs = serverTimingAppMs(response.headers.get("server-timing"));
      // Body read is part of the round trip: large responses stream after the headers arrive.
      return await this.responsePayload<T>(response);
    } catch (error) {
      if (error instanceof KaneraApiError && status === 0) status = error.status;
      throw error;
    } finally {
      this.options.onUpstreamRequest?.({
        method,
        route: upstreamRouteTemplate(url.pathname),
        status,
        phase,
        durationMs: performance.now() - startedAt,
        appMs,
      });
    }
  }

  private url(
    path: string,
    query?: Record<string, string | number | boolean | null | undefined>,
  ): URL {
    const url = new URL(path.startsWith("/") ? path : `/api/v1/${path}`, this.baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    return url;
  }

  private headers(json = false, mutation = false): Record<string, string> {
    return {
      authorization: `Bearer ${this.options.apiKey}`,
      accept: "application/json",
      // The public API uses this analytics-only provenance marker to distinguish official MCP
      // activity from other API-key traffic. It grants no capability and is never trusted for auth.
      "x-kanera-client": "mcp",
      ...(json ? { "content-type": "application/json" } : {}),
      ...(mutation && this.options.idempotencyKey ? { "idempotency-key": this.options.idempotencyKey } : {}),
    };
  }

  private signal(): AbortSignal {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 15_000);
    return this.options.signal ? AbortSignal.any([this.options.signal, timeout]) : timeout;
  }

  private async fetchResponse(input: URL, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(input, init);
    } catch (error) {
      if (this.options.signal?.aborted) {
        throw new KaneraApiError(499, "REQUEST_CANCELLED", "MCP request was cancelled by the client");
      }
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new KaneraApiError(504, "UPSTREAM_TIMEOUT", "Kanera did not respond before the MCP upstream timeout");
      }
      throw new KaneraApiError(503, "UPSTREAM_UNAVAILABLE", "Kanera is temporarily unavailable");
    }
  }

  private async responsePayload<T>(response: Response): Promise<T> {
    const text = await response.text();
    const payload = this.parsePayload(text, response);
    if (!response.ok) {
      const problem = typeof payload === "object" && payload ? payload as { code?: string; message?: string; reason?: unknown } : {};
      throw new KaneraApiError(
        response.status,
        problem.code ?? this.defaultCode(response.status),
        problem.message ?? (response.statusText || "public API request failed"),
        response.headers.get("retry-after"),
        problem,
      );
    }
    return payload as T;
  }

  private parsePayload(text: string, response: Response): unknown {
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      if (!response.ok) return null;
      throw new KaneraApiError(
        response.status,
        "INVALID_PUBLIC_API_RESPONSE",
        "public API returned an invalid JSON response",
        response.headers.get("retry-after"),
      );
    }
  }

  private defaultCode(status: number): string {
    if (status === 401) return "UNAUTHENTICATED";
    if (status === 403) return "FORBIDDEN";
    if (status === 404) return "NOT_FOUND";
    if (status === 429) return "RATE_LIMITED";
    return "PUBLIC_API_ERROR";
  }
}
