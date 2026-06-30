import { z } from "zod";
import { GENERAL_NAME_MAX_LENGTH } from "./name-limits.js";

export const workspaceApiKeyScope = z.enum(["read", "write", "admin"]);
export type WorkspaceApiKeyScopeDto = z.infer<typeof workspaceApiKeyScope>;

export const createWorkspaceApiKeyBody = z.object({
  name: z.string().trim().min(1).max(GENERAL_NAME_MAX_LENGTH),
  scope: workspaceApiKeyScope.default("read"),
});
export type CreateWorkspaceApiKeyBody = z.infer<typeof createWorkspaceApiKeyBody>;

export const webhookEventType = z.string().trim().min(1).max(GENERAL_NAME_MAX_LENGTH);

export const createWebhookEndpointBody = z.object({
  name: z.string().trim().min(1).max(GENERAL_NAME_MAX_LENGTH),
  url: z.url().max(2000),
  eventTypes: z.array(webhookEventType).default([]),
  enabled: z.boolean().default(true),
});
export type CreateWebhookEndpointBody = z.infer<typeof createWebhookEndpointBody>;

export const updateWebhookEndpointBody = z.object({
  name: z.string().trim().min(1).max(GENERAL_NAME_MAX_LENGTH).optional(),
  url: z.url().max(2000).optional(),
  eventTypes: z.array(webhookEventType).optional(),
  enabled: z.boolean().optional(),
}).refine(
  (v) => v.name !== undefined || v.url !== undefined || v.eventTypes !== undefined || v.enabled !== undefined,
  "provide an update",
);
export type UpdateWebhookEndpointBody = z.infer<typeof updateWebhookEndpointBody>;

export const listWebhookDeliveriesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(25).default(25),
});
export type ListWebhookDeliveriesQuery = z.infer<typeof listWebhookDeliveriesQuery>;
