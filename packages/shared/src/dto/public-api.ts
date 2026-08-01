import { z } from "zod";
import { WORKSPACE_API_KEY_SCOPES } from "../schema/workspace-api-key.js";
import { CHAT_DESTINATION_EVENT_TYPES, CHAT_DESTINATION_PROVIDERS } from "../schema/webhook-endpoint.js";
import { API_KEY_NAME_MAX_LENGTH, GENERAL_NAME_MAX_LENGTH } from "./name-limits.js";

export const workspaceApiKeyScope = z.enum(WORKSPACE_API_KEY_SCOPES);
export type WorkspaceApiKeyScopeDto = z.infer<typeof workspaceApiKeyScope>;

export const createWorkspaceApiKeyBody = z.object({
  name: z.string().trim().min(1).max(API_KEY_NAME_MAX_LENGTH),
  scope: workspaceApiKeyScope.default("read"),
});
export type CreateWorkspaceApiKeyBody = z.infer<typeof createWorkspaceApiKeyBody>;

export const updateWorkspaceApiKeyBody = z.object({
  name: z.string().trim().min(1).max(API_KEY_NAME_MAX_LENGTH),
});
export type UpdateWorkspaceApiKeyBody = z.infer<typeof updateWorkspaceApiKeyBody>;

// Personal keys act as the owner (board-content only, cross-workspace) and are always read-write, so
// they carry no scope. The only input is an optional private label shown solely in the owner's list.
export const createPersonalApiKeyBody = z.object({
  label: z.string().trim().min(1).max(API_KEY_NAME_MAX_LENGTH).optional(),
});
export type CreatePersonalApiKeyBody = z.infer<typeof createPersonalApiKeyBody>;

export const createAgentConnectionBody = z.object({
  name: z.string().trim().min(1).max(GENERAL_NAME_MAX_LENGTH),
  scope: workspaceApiKeyScope.default("read"),
});
export type CreateAgentConnectionBody = z.infer<typeof createAgentConnectionBody>;

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

export const chatDestinationProvider = z.enum(CHAT_DESTINATION_PROVIDERS);
export const chatDestinationEventType = z.enum(CHAT_DESTINATION_EVENT_TYPES);
const chatDestinationCommon = {
  name: z.string().trim().min(1).max(GENERAL_NAME_MAX_LENGTH),
  eventTypes: z.array(chatDestinationEventType).min(1),
  priorityFieldId: z.uuid().nullable().default(null),
  enabled: z.boolean().default(true),
};

export const createChatDestinationBody = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("slack"), ...chatDestinationCommon, credentials: z.object({ webhookUrl: z.url().max(2000) }) }),
  z.object({ provider: z.literal("discord"), ...chatDestinationCommon, credentials: z.object({ webhookUrl: z.url().max(2000) }) }),
  z.object({ provider: z.literal("zulip"), ...chatDestinationCommon, credentials: z.object({ webhookUrl: z.url().max(2000) }) }),
  z.object({
    provider: z.literal("telegram"),
    ...chatDestinationCommon,
    credentials: z.object({
      botToken: z.string().trim().min(1).max(256),
      chatId: z.string().trim().min(1).max(128),
      threadId: z.number().int().positive().nullable().default(null),
    }),
  }),
]);
export type CreateChatDestinationBody = z.infer<typeof createChatDestinationBody>;

export const updateChatDestinationBody = z.object({
  name: z.string().trim().min(1).max(GENERAL_NAME_MAX_LENGTH).optional(),
  eventTypes: z.array(chatDestinationEventType).min(1).optional(),
  priorityFieldId: z.uuid().nullable().optional(),
  enabled: z.boolean().optional(),
  credentials: z.union([
    z.object({ webhookUrl: z.url().max(2000) }),
    z.object({ botToken: z.string().trim().min(1).max(256), chatId: z.string().trim().min(1).max(128), threadId: z.number().int().positive().nullable().default(null) }),
  ]).optional(),
}).refine((value) => Object.keys(value).length > 0, "provide an update");
export type UpdateChatDestinationBody = z.infer<typeof updateChatDestinationBody>;
