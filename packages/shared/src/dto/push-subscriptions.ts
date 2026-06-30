import { z } from "zod";
import { GENERAL_NAME_MAX_LENGTH } from "./name-limits.js";

export const pushNotificationsConfigResponse = z.object({
  status: z.enum(["enabled", "org-disabled", "system-disabled"]),
  enabled: z.boolean(),
  publicKey: z.string().min(1).nullable(),
});
export type PushNotificationsConfigResponse = z.infer<typeof pushNotificationsConfigResponse>;

export const pushSubscriptionBody = z.object({
  endpoint: z.url(),
  expirationTime: z.number().int().nullable().optional(),
  contentEncoding: z.string().trim().min(1).max(64).optional(),
  deviceLabel: z.string().trim().min(1).max(GENERAL_NAME_MAX_LENGTH).optional(),
  userAgent: z.string().trim().min(1).max(512).optional(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});
export type PushSubscriptionBody = z.infer<typeof pushSubscriptionBody>;

export const deletePushSubscriptionBody = z.object({
  endpoint: z.url(),
});
export type DeletePushSubscriptionBody = z.infer<typeof deletePushSubscriptionBody>;

export const pushTestBody = z.object({
  kind: z.string().trim().min(1).max(64).default("test"),
  title: z.string().trim().min(1).max(GENERAL_NAME_MAX_LENGTH).default("Kanera test notification"),
  body: z.string().trim().min(1).max(240).default("Push notifications are configured correctly."),
  url: z.string().trim().min(1).max(2048).default("/"),
  tag: z.string().trim().min(1).max(GENERAL_NAME_MAX_LENGTH).optional(),
});
export type PushTestBody = z.infer<typeof pushTestBody>;

export const pushTestResponse = z.object({
  attempted: z.number().int().nonnegative(),
  delivered: z.number().int().nonnegative(),
  disabled: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type PushTestResponse = z.infer<typeof pushTestResponse>;

export const pushSubscriptionRefreshBody = z.object({
  oldEndpoint: z.url(),
  endpoint: z.url(),
  expirationTime: z.number().int().nullable().optional(),
  contentEncoding: z.string().trim().min(1).max(64).optional(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});
export type PushSubscriptionRefreshBody = z.infer<typeof pushSubscriptionRefreshBody>;
