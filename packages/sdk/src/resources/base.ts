import type { KaneraHttpClient, RequestOptions } from "../client.js";
import type { Uuid } from "../types.js";

export interface ResourceContext {
  http: KaneraHttpClient;
  /** Accepts a card UUID, a key such as `MKT-42`, or a canonical card URL. */
  resolveCard(reference: string): Promise<Uuid>;
}

/** Options every method accepts, so a caller can always pass a signal or an idempotency key. */
export type CallOptions = Pick<RequestOptions, "signal" | "timeoutMs" | "idempotencyKey" | "organisationId" | "headers">;
