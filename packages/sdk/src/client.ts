import { KaneraApiError, KaneraConnectionError } from "./errors.js";

export type QueryValue = string | number | boolean | null | undefined;
export type Query = Record<string, QueryValue | QueryValue[]>;

export interface RequestOptions {
  query?: Query;
  /** Extra headers merged over the defaults; `authorization` cannot be overridden. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Overrides the client-wide timeout for one call. */
  timeoutMs?: number;
  /**
   * Makes a mutation safe to retry. The API retains the first outcome for 24 hours and replays it
   * rather than performing the write twice, so this is what turns a POST into something the retry
   * policy is allowed to touch.
   */
  idempotencyKey?: string;
  /**
   * Pin the request to one organisation. Personal credentials are identity-wide across the owner's
   * live memberships, so a user in several organisations must say which one they mean.
   */
  organisationId?: string;
}

export interface KaneraClientOptions {
  /** A Kanera API key: personal (`kanera_u_…`) or workspace. */
  apiKey: string;
  /** Defaults to the hosted API. Point this at your own deployment when self-hosting. */
  baseUrl?: string;
  /** Deadline for each attempt; retries get a fresh timeout. Default 30s. */
  timeoutMs?: number;
  /** Attempts after the first for retryable failures. Default 2; set 0 to disable. */
  maxRetries?: number;
  /** Injected for tests, or to supply a fetch with your own agent/proxy. */
  fetch?: typeof fetch;
  /** Appended to the SDK's own User-Agent, to identify your integration in support requests. */
  userAgent?: string;
  organisationId?: string;
  /** Called before each retry. Useful for logging or metrics. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown; method: string; path: string }) => void;
}

const DEFAULT_BASE_URL = "https://api.kanera.app";
const SDK_VERSION = "1.5.0";
const RETRYABLE_METHODS = new Set(["GET", "HEAD", "DELETE", "PUT"]);

function encodeQuery(query: Query | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    const values = Array.isArray(value) ? value : [value];
    // Repeated keys rather than a joined string: that is how the API's array query params parse.
    for (const entry of values) if (entry !== undefined && entry !== null) params.append(key, String(entry));
  }
  const encoded = params.toString();
  return encoded === "" ? "" : `?${encoded}`;
}

/**
 * Low-level transport for the Kanera public API.
 *
 * Deliberately dependency-free and built on global `fetch`, so the package runs unchanged on Node
 * 18+, Bun, Deno, Cloudflare Workers, and browsers. Note that using it from a browser means
 * shipping an API key to the client — only do that in a trusted first-party context.
 *
 * Resource namespaces on {@link Kanera} wrap this; `request` stays public because the API moves
 * faster than the typed surface and a caller should never be blocked waiting for a wrapper.
 */
export class KaneraHttpClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(private readonly options: KaneraClientOptions) {
    if (!options.apiKey) throw new TypeError("apiKey is required");
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/u, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof this.fetchImpl !== "function") {
      throw new TypeError("global fetch is unavailable; pass one via the fetch option");
    }
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
  }

  get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>("GET", path, undefined, options);
  }

  post<T>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    return this.request<T>("POST", path, body, options);
  }

  patch<T>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    return this.request<T>("PATCH", path, body, options);
  }

  put<T>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    return this.request<T>("PUT", path, body, options);
  }

  delete<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>("DELETE", path, undefined, options);
  }

  /** Multipart upload. `file` accepts a Blob/File, or bytes plus a filename and type. */
  async upload<T>(
    path: string,
    file: Blob | { bytes: Uint8Array; fileName: string; contentType?: string },
    options: RequestOptions = {},
  ): Promise<T> {
    const form = new FormData();
    if (file instanceof Blob) form.append("file", file);
    else {
      // Copy into a fresh ArrayBuffer view: BlobPart excludes SharedArrayBuffer, which a caller's
      // Uint8Array may be backed by.
      const bytes = new Uint8Array(file.bytes.byteLength);
      bytes.set(file.bytes);
      form.append("file", new Blob([bytes], { type: file.contentType ?? "application/octet-stream" }), file.fileName);
    }
    // FormData sets its own multipart boundary; setting content-type here would corrupt the body.
    return this.request<T>("POST", path, form, options);
  }

  async request<T>(method: string, path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/api/v1/${path}`}${encodeQuery(options.query)}`;
    const isForm = body instanceof FormData;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.options.apiKey}`,
      accept: "application/json",
      "user-agent": this.options.userAgent
        ? `kanera-sdk/${SDK_VERSION} ${this.options.userAgent}`
        : `kanera-sdk/${SDK_VERSION}`,
      // Provenance marker only. The API does not read it today; it exists so official SDK traffic
      // stays distinguishable from hand-rolled API-key traffic in access logs.
      "x-kanera-client": "sdk",
      ...options.headers,
    };
    if (body !== undefined && !isForm) headers["content-type"] = "application/json";
    if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
    const organisationId = options.organisationId ?? this.options.organisationId;
    if (organisationId) headers["x-kanera-organisation-id"] = organisationId;

    // A mutation is only retried when the caller supplied an idempotency key; without one, a retry
    // after an ambiguous failure could create a second card or post a second comment.
    const retryable = RETRYABLE_METHODS.has(method) || options.idempotencyKey !== undefined;
    const attempts = retryable ? this.maxRetries + 1 : 1;
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.attempt<T>(method, url, headers, body, isForm, options);
      } catch (error) {
        lastError = error;
        const isLast = attempt === attempts - 1;
        if (isLast || !this.shouldRetry(error)) throw error;
        const delayMs = this.backoffMs(attempt, error);
        this.options.onRetry?.({ attempt: attempt + 1, delayMs, error, method, path });
        await sleep(delayMs, options.signal);
      }
    }
    throw lastError;
  }

  private async attempt<T>(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: unknown,
    isForm: boolean,
    options: RequestOptions,
  ): Promise<T> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : isForm ? body as FormData : JSON.stringify(body),
        signal,
      });
    } catch (error) {
      // The caller's own abort is not a Kanera failure and must surface as itself, so a caller
      // cancelling a request never sees it reported as a timeout.
      if (options.signal?.aborted) throw error;
      const timedOut = timeout.aborted;
      throw new KaneraConnectionError(
        timedOut ? `Kanera did not respond within ${options.timeoutMs ?? this.timeoutMs}ms` : "could not reach Kanera",
        error,
        timedOut,
      );
    }

    const text = await response.text();
    const payload = text === "" ? null : safeJson(text);
    if (!response.ok) {
      const problem = payload && typeof payload === "object" ? payload as { code?: string; message?: string } : {};
      throw new KaneraApiError(
        response.status,
        problem.code ?? `HTTP_${response.status}`,
        problem.message ?? response.statusText ?? "the Kanera request failed",
        {
          retryAfter: response.headers.get("retry-after"),
          body: payload,
          requestId: response.headers.get("x-request-id"),
          method,
          path: url,
        },
      );
    }
    return payload as T;
  }

  private shouldRetry(error: unknown): boolean {
    if (error instanceof KaneraApiError) return error.isRetryable;
    // A timeout is worth another attempt; a caller abort or a programming error is not.
    return error instanceof KaneraConnectionError;
  }

  private backoffMs(attempt: number, error: unknown): number {
    if (error instanceof KaneraApiError) {
      const serverAsked = error.retryAfterMs();
      // The server knows when its rate-limit window resets; guessing shorter just burns quota.
      if (serverAsked !== null) return Math.min(serverAsked, 60_000);
    }
    const base = Math.min(500 * 2 ** attempt, 8_000);
    // Full jitter: fleets of workers that fail together must not retry together.
    return Math.round(base * (0.5 + Math.random() * 0.5));
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal!.reason as Error);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
