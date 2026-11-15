import { z } from "zod";
import { GENERAL_NAME_MAX_LENGTH } from "./name-limits.js";

export const pushNotificationsConfigResponse = z.object({
  status: z.enum(["enabled", "org-disabled", "system-disabled"]),
  registrationEnabled: z.boolean(),
  enabled: z.boolean(),
  publicKey: z.string().min(1).nullable(),
});
export type PushNotificationsConfigResponse = z.infer<typeof pushNotificationsConfigResponse>;

const pushEndpoint = z.url({ protocol: /^https$/ }).max(4096);
const pushExpiration = z.number().int().min(0).max(8_640_000_000_000_000).nullable().optional();
const contentEncoding = z.enum(["aes128gcm", "aesgcm"]).optional();
const pushKeys = z.object({
  // Uncompressed P-256 public point (65 bytes), and the 16-byte Web Push auth secret.
  p256dh: z.string().regex(/^B[A-Za-z0-9_-]{86}=?$/),
  auth: z.string().regex(/^[A-Za-z0-9_-]{22}(?:==)?$/),
});

export const pushSubscriptionBody = z.object({
  endpoint: pushEndpoint,
  expirationTime: pushExpiration,
  contentEncoding,
  deviceLabel: z.string().trim().min(1).max(GENERAL_NAME_MAX_LENGTH).optional(),
  userAgent: z.string().trim().min(1).max(512).optional(),
  keys: pushKeys,
});
export type PushSubscriptionBody = z.infer<typeof pushSubscriptionBody>;

export const deletePushSubscriptionBody = z.object({
  endpoint: z.url(),
});
export type DeletePushSubscriptionBody = z.infer<typeof deletePushSubscriptionBody>;

export const pushTestBody = z.object({
  kind: z.string().trim().min(1).max(64).default("test"),
  // Omitted by the web app: the API fills them in the requester's language.
  title: z.string().trim().min(1).max(GENERAL_NAME_MAX_LENGTH).optional(),
  body: z.string().trim().min(1).max(240).optional(),
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
  oldEndpoint: pushEndpoint,
  // The endpoint is a capability URL but can still leak through logs. Requiring the old Web Push
  // auth secret prevents an endpoint-only leak from rotating someone else's subscription.
  oldAuth: z.string().min(1).max(64),
  endpoint: pushEndpoint,
  expirationTime: pushExpiration,
  contentEncoding,
  keys: pushKeys,
});
export type PushSubscriptionRefreshBody = z.infer<typeof pushSubscriptionRefreshBody>;
