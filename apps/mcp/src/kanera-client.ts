export class KaneraApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfter?: string | null,
  ) {
    super(message);
  }
}

export interface KaneraClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export class KaneraClient {
  private readonly baseUrl: URL;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: KaneraClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
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

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | null | undefined>,
  ): Promise<T> {
    const url = new URL(path.startsWith("/") ? path : `/api/v1/${path}`, this.baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const response = await this.fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const payload = this.parsePayload(text, response);
    if (!response.ok) {
      const problem = typeof payload === "object" && payload ? payload as { code?: string; message?: string } : {};
      throw new KaneraApiError(
        response.status,
        problem.code ?? this.defaultCode(response.status),
        problem.message ?? (response.statusText || "public API request failed"),
        response.headers.get("retry-after"),
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
