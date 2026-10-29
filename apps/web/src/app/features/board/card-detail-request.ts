import type { ApiClient, ConditionalResponse } from "../../core/api/api.client";

/** Single-flight read owned by a detail/feed loader, cancelled when its card or connectivity changes. */
export class CardDetailRequest {
  private cachedPath: string | undefined;
  private conditional: ConditionalResponse<unknown> = {};
  private pending?: { path: string; controller: AbortController; promise: Promise<unknown> };

  constructor(private readonly api: ApiClient) {}

  get<T>(path: string): Promise<T> {
    if (this.pending?.path === path) return this.pending.promise as Promise<T>;
    this.cancel();
    if (this.cachedPath !== path) { this.cachedPath = path; this.conditional = {}; }
    const controller = new AbortController();
    const conditional = { ...this.conditional } as ConditionalResponse<T>;
    const promise = this.api.get<T>(path, { signal: controller.signal, conditional });
    const pending = { path, controller, promise };
    this.pending = pending;
    // Register both outcomes without creating an unhandled rejected finally() promise.
    const settled = () => { if (this.pending === pending) this.pending = undefined; };
    void promise.then(() => {
      if (this.pending === pending) this.conditional = conditional;
      settled();
    }, settled);
    return promise;
  }

  cancel() {
    this.pending?.controller.abort();
    this.pending = undefined;
  }
}
