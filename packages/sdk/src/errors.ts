/**
 * Every non-2xx response becomes one of these. The public API returns a problem document with a
 * stable `code`, which is more useful to branch on than the HTTP status: `FORBIDDEN` from a
 * read-scoped credential and `FORBIDDEN` from missing board access are the same status but very
 * different situations for the caller, and the message distinguishes them.
 */
export class KaneraApiError extends Error {
  readonly name = "KaneraApiError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly options: {
      /** Seconds or HTTP-date from the `Retry-After` header, when the server sent one. */
      retryAfter?: string | null;
      /** The parsed response body, for fields beyond `code` and `message`. */
      body?: unknown;
      requestId?: string | null;
      method?: string;
      path?: string;
    } = {},
  ) {
    super(message);
  }

  /** No credential, or one that has been revoked. */
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }

  /**
   * The credential is valid but may not do this — most often a read-scoped key attempting a write,
   * which no amount of retrying will fix.
   */
  get isForbidden(): boolean {
    return this.status === 403;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }

  /** Retrying may succeed: rate limits and transient upstream failures. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status === 408 || (this.status >= 500 && this.status !== 501);
  }

  /** `Retry-After` in milliseconds, accepting both the delta-seconds and HTTP-date forms. */
  retryAfterMs(now = Date.now()): number | null {
    const value = this.options.retryAfter;
    if (!value) return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(value);
    return Number.isNaN(date) ? null : Math.max(0, date - now);
  }
}

/** The request never reached Kanera, or was aborted before a response arrived. */
export class KaneraConnectionError extends Error {
  readonly name = "KaneraConnectionError";

  constructor(message: string, readonly cause?: unknown, readonly timedOut = false) {
    super(message);
  }
}

export function isKaneraApiError(error: unknown): error is KaneraApiError {
  return error instanceof KaneraApiError;
}
