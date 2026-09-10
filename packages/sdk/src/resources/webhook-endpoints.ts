import type { Uuid } from "../types.js";
import type { CallOptions, ResourceContext } from "./base.js";

export interface WebhookEndpoint {
  id: Uuid;
  workspaceId: Uuid;
  name: string;
  url: string;
  /** Empty means every event. */
  eventTypes: string[];
  enabled: boolean;
  /**
   * `workspace` endpoints are managed by workspace admins. `connection` endpoints were registered by
   * a credential without admin authority and are visible only to that connection and to admins.
   */
  scope: "workspace" | "connection";
  lastSuccessfulAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The signing secret is returned only from create() and rotateSecret(). */
export type CreatedWebhookEndpoint = WebhookEndpoint & { secret: string };

export interface CreateWebhookEndpointInput {
  name: string;
  url: string;
  /** Omit or pass [] to receive every event. */
  eventTypes?: string[];
  enabled?: boolean;
}

/** At least one field is required. */
export interface UpdateWebhookEndpointInput {
  name?: string;
  url?: string;
  eventTypes?: string[];
  enabled?: boolean;
}

export interface WebhookDelivery {
  id: Uuid;
  endpointId: Uuid;
  workspaceId: Uuid;
  outboxEventId: Uuid | null;
  eventType: string;
  payload: unknown;
  status: "queued" | "delivering" | "success" | "failed";
  attempts: number;
  nextAttemptAt: string;
  lastAttemptAt: string | null;
  responseStatus: number | null;
  responseBody: string | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Outgoing webhook subscriptions.
 *
 * A workspace admin sees and manages every endpoint. Any other write-capable credential (a
 * write-scoped key or an OAuth agent grant) that is a workspace member may register endpoints too,
 * but only ever sees the ones its own connection created — so an agent can subscribe to events
 * without being handed admin authority. Verify incoming deliveries with {@link parseWebhook}.
 */
export class WebhookEndpoints {
  constructor(private readonly ctx: ResourceContext) {}

  list(workspaceId: Uuid, options: CallOptions = {}): Promise<WebhookEndpoint[]> {
    return this.ctx.http.get<WebhookEndpoint[]>(`/api/v1/workspaces/${workspaceId}/webhooks`, options);
  }

  /** The returned `secret` is shown once; store it before the promise settles elsewhere. */
  create(workspaceId: Uuid, input: CreateWebhookEndpointInput, options: CallOptions = {}): Promise<CreatedWebhookEndpoint> {
    return this.ctx.http.post<CreatedWebhookEndpoint>(`/api/v1/workspaces/${workspaceId}/webhooks`, input, options);
  }

  update(workspaceId: Uuid, endpointId: Uuid, input: UpdateWebhookEndpointInput, options: CallOptions = {}): Promise<WebhookEndpoint> {
    return this.ctx.http.patch<WebhookEndpoint>(`/api/v1/workspaces/${workspaceId}/webhooks/${endpointId}`, input, options);
  }

  delete(workspaceId: Uuid, endpointId: Uuid, options: CallOptions = {}): Promise<void> {
    return this.ctx.http.delete<void>(`/api/v1/workspaces/${workspaceId}/webhooks/${endpointId}`, options);
  }

  /** Deliveries signed with the previous secret stop verifying immediately. */
  rotateSecret(workspaceId: Uuid, endpointId: Uuid, options: CallOptions = {}): Promise<CreatedWebhookEndpoint> {
    return this.ctx.http.post<CreatedWebhookEndpoint>(`/api/v1/workspaces/${workspaceId}/webhooks/${endpointId}/secret`, undefined, options);
  }

  deliveries(workspaceId: Uuid, endpointId: Uuid, options: { limit?: number } & CallOptions = {}): Promise<WebhookDelivery[]> {
    const { limit, ...call } = options;
    return this.ctx.http.get<WebhookDelivery[]>(`/api/v1/workspaces/${workspaceId}/webhooks/${endpointId}/deliveries`, { ...call, query: { limit } });
  }

  retryDelivery(workspaceId: Uuid, endpointId: Uuid, deliveryId: Uuid, options: CallOptions = {}): Promise<WebhookDelivery> {
    return this.ctx.http.post<WebhookDelivery>(`/api/v1/workspaces/${workspaceId}/webhooks/${endpointId}/deliveries/${deliveryId}/retry`, undefined, options);
  }
}
