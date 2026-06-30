import type { PushSubscriptionBody, PushTestBody, PushTestResponse } from "@kanera/shared/dto";
import { clients, pushSubscriptions, SYSTEM_CONFIG_ROW_ID, systemConfigs } from "@kanera/shared/schema";
import { and, eq, isNull } from "drizzle-orm";
import webPush, { type ContentEncoding } from "web-push";
import type { Db } from "../db.js";
import { db } from "../db.js";
import { env } from "../env.js";
import { AppError } from "./errors.js";
import { decryptSecret, encryptSecret } from "./secrets.js";

const WEB_PUSH_DISABLED_MESSAGE = "web push is not configured";
const WEB_PUSH_ORG_DISABLED_MESSAGE = "push messages are disabled for this organisation";
const DEFAULT_VAPID_MAILBOX = "push";
const DEFAULT_VAPID_LOCAL_DOMAIN = "localhost.localdomain";

/** Default TTL in seconds for push messages (24 hours). */
export const DEFAULT_PUSH_TTL = 86_400;

type StoredPushSubscription = typeof pushSubscriptions.$inferSelect;
type ResolvedVapidConfig = {
  subject: string;
  publicKey: string;
  privateKey: string;
};

export const webPushClient = {
  setVapidDetails(subject: string, publicKey: string, privateKey: string) {
    webPush.setVapidDetails(subject, publicKey, privateKey);
  },
  generateVAPIDKeys() {
    return webPush.generateVAPIDKeys();
  },
  sendNotification(
    subscription: webPush.PushSubscription,
    payload: string,
    options?: webPush.RequestOptions,
  ) {
    return webPush.sendNotification(subscription, payload, options);
  },
};

let vapidInitialisedFingerprint: string | null = null;

async function getStoredVapidConfig(): Promise<ResolvedVapidConfig | null> {
  const [row] = await db.select().from(systemConfigs).where(eq(systemConfigs.id, SYSTEM_CONFIG_ROW_ID)).limit(1);
  if (!row?.vapidSubject || !row.vapidPublicKey || !row.vapidPrivateKey) return null;
  return {
    subject: row.vapidSubject,
    publicKey: row.vapidPublicKey,
    privateKey: decryptSecret(row.vapidPrivateKey),
  };
}

function vapidFingerprint(config: ResolvedVapidConfig) {
  return `${config.subject}\0${config.publicKey}\0${config.privateKey}`;
}

function buildGeneratedVapidSubject() {
  try {
    const origin = new URL(env.WEB_ORIGIN);
    if (origin.protocol === "https:") return origin.origin;
    const hostname = origin.hostname && origin.hostname !== "localhost" ? origin.hostname : DEFAULT_VAPID_LOCAL_DOMAIN;
    return `mailto:${DEFAULT_VAPID_MAILBOX}@${hostname}`;
  } catch {
    return `mailto:${DEFAULT_VAPID_MAILBOX}@${DEFAULT_VAPID_LOCAL_DOMAIN}`;
  }
}

async function resolveVapidConfig(): Promise<ResolvedVapidConfig | null> {
  return getStoredVapidConfig();
}

async function isClientPushEnabled(clientId: string): Promise<boolean> {
  const [row] = await db.select({ pushEnabled: clients.pushEnabled }).from(clients).where(eq(clients.id, clientId)).limit(1);
  if (!row) throw new AppError(404, "NOT_FOUND", "client not found");
  return row.pushEnabled;
}

async function ensureWebPushConfigured(clientId?: string) {
  if (clientId && !await isClientPushEnabled(clientId)) {
    throw new AppError(403, "FORBIDDEN", WEB_PUSH_ORG_DISABLED_MESSAGE);
  }

  const config = await resolveVapidConfig();
  if (!config) {
    throw new AppError(503, "SERVICE_UNAVAILABLE", WEB_PUSH_DISABLED_MESSAGE);
  }

  const fingerprint = vapidFingerprint(config);
  if (vapidInitialisedFingerprint !== fingerprint) {
    webPushClient.setVapidDetails(config.subject!, config.publicKey!, config.privateKey!);
    vapidInitialisedFingerprint = fingerprint;
  }

  return config;
}

export async function ensureSystemWebPushConfig(): Promise<ResolvedVapidConfig> {
  const storedConfig = await getStoredVapidConfig();
  if (storedConfig) return storedConfig;

  const generated = webPushClient.generateVAPIDKeys();
  const subject = buildGeneratedVapidSubject();
  const now = new Date();

  await db
    .insert(systemConfigs)
    .values({
      id: SYSTEM_CONFIG_ROW_ID,
      vapidSubject: subject,
      vapidPublicKey: generated.publicKey,
      vapidPrivateKey: encryptSecret(generated.privateKey),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  const resolved = await getStoredVapidConfig();
  if (resolved) return resolved;

  throw new AppError(500, "INTERNAL", "failed to persist web push configuration");
}

function toStoredExpirationTime(expirationTime: number | null | undefined) {
  return expirationTime == null ? null : new Date(expirationTime);
}

export function toPushSubscription(row: StoredPushSubscription): webPush.PushSubscription {
  return {
    endpoint: row.endpoint,
    expirationTime: row.expirationTime?.getTime() ?? null,
    keys: {
      p256dh: row.keyP256dh,
      auth: row.keyAuth,
    },
  };
}

function statusCodeFromError(err: unknown) {
  return typeof err === "object" && err && "statusCode" in err && typeof err.statusCode === "number"
    ? err.statusCode
    : null;
}

function describeWebPushError(err: unknown) {
  if (Error.isError(err)) {
    const statusCode = statusCodeFromError(err);
    const responseBody = (err as unknown as { body?: unknown }).body;
    const details = typeof responseBody === "string" ? responseBody : null;
    return [statusCode ? `status=${statusCode}` : null, err.message, details].filter(Boolean).join(": ");
  }
  return String(err);
}

function isPermanentSubscriptionError(err: unknown) {
  const statusCode = statusCodeFromError(err);
  return statusCode === 404 || statusCode === 410;
}

/**
 * Ensures VAPID credentials are resolved and configured for the given org.
 * Exported for use by the push queue worker.
 */
export async function ensureWebPushReady(clientId?: string) {
  return ensureWebPushConfigured(clientId);
}

/**
 * Handle an error from sending to a push subscription: updates the subscription
 * row with failure info and disables it if the error is permanent (404/410).
 * Returns "disabled" or "failed" to indicate what happened.
 */
export async function handleSubscriptionError(
  database: Db,
  sub: { id: string; failureCount: number },
  err: unknown,
): Promise<"disabled" | "failed"> {
  const now = new Date();
  const permanent = isPermanentSubscriptionError(err);
  await database
    .update(pushSubscriptions)
    .set({
      failureCount: sub.failureCount + 1,
      lastError: describeWebPushError(err),
      disabledAt: permanent ? now : null,
      updatedAt: now,
    })
    .where(eq(pushSubscriptions.id, sub.id));
  return permanent ? "disabled" : "failed";
}

export async function getWebPushPublicConfig(clientId: string) {
  if (!await isClientPushEnabled(clientId)) {
    return {
      status: "org-disabled" as const,
      enabled: false,
      publicKey: null,
    };
  }

  const config = await resolveVapidConfig();
  if (!config) {
    return {
      status: "system-disabled" as const,
      enabled: false,
      publicKey: null,
    };
  }

  return {
    status: "enabled" as const,
    enabled: true,
    publicKey: config.publicKey,
  };
}

export async function upsertPushSubscriptionForUser(args: {
  clientId: string;
  userId: string;
  subscription: PushSubscriptionBody;
  userAgent?: string | null;
}) {
  await ensureWebPushConfigured(args.clientId);

  const now = new Date();
  await db
    .insert(pushSubscriptions)
    .values({
      clientId: args.clientId,
      userId: args.userId,
      endpoint: args.subscription.endpoint,
      keyP256dh: args.subscription.keys.p256dh,
      keyAuth: args.subscription.keys.auth,
      expirationTime: toStoredExpirationTime(args.subscription.expirationTime),
      contentEncoding: args.subscription.contentEncoding ?? null,
      deviceLabel: args.subscription.deviceLabel ?? null,
      userAgent: args.subscription.userAgent ?? args.userAgent ?? null,
      lastSeenAt: now,
      disabledAt: null,
      lastError: null,
      failureCount: 0,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: {
        clientId: args.clientId,
        userId: args.userId,
        keyP256dh: args.subscription.keys.p256dh,
        keyAuth: args.subscription.keys.auth,
        expirationTime: toStoredExpirationTime(args.subscription.expirationTime),
        contentEncoding: args.subscription.contentEncoding ?? null,
        deviceLabel: args.subscription.deviceLabel ?? null,
        userAgent: args.subscription.userAgent ?? args.userAgent ?? null,
        lastSeenAt: now,
        disabledAt: null,
        lastError: null,
        failureCount: 0,
        updatedAt: now,
      },
    });
}

export async function deletePushSubscriptionForUser(args: {
  clientId: string;
  userId: string;
  endpoint: string;
}) {
  await db
    .delete(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.clientId, args.clientId),
        eq(pushSubscriptions.userId, args.userId),
        eq(pushSubscriptions.endpoint, args.endpoint),
      ),
    );
}

/**
 * Handle a pushsubscriptionchange event from the service worker.
 * Looks up the existing subscription by oldEndpoint and updates it with the
 * new endpoint and keys. Returns true if a row was found and updated.
 */
export async function refreshPushSubscription(args: {
  oldEndpoint: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  expirationTime?: number | null;
  contentEncoding?: string | null;
}): Promise<boolean> {
  const now = new Date();
  const [existing] = await db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.endpoint, args.oldEndpoint))
    .limit(1);

  if (!existing) return false;

  await db
    .update(pushSubscriptions)
    .set({
      endpoint: args.endpoint,
      keyP256dh: args.keys.p256dh,
      keyAuth: args.keys.auth,
      expirationTime: args.expirationTime == null ? null : new Date(args.expirationTime),
      contentEncoding: args.contentEncoding ?? null,
      lastSeenAt: now,
      disabledAt: null,
      lastError: null,
      failureCount: 0,
      updatedAt: now,
    })
    .where(eq(pushSubscriptions.id, existing.id));

  return true;
}

export async function sendWebPushToUser(args: {
  clientId: string;
  userId: string;
  payload: PushTestBody;
}): Promise<PushTestResponse> {
  await ensureWebPushConfigured(args.clientId);

  const rows = await db
    .select()
    .from(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.clientId, args.clientId),
        eq(pushSubscriptions.userId, args.userId),
        isNull(pushSubscriptions.disabledAt),
      ),
    );

  const result: PushTestResponse = {
    attempted: rows.length,
    delivered: 0,
    disabled: 0,
    failed: 0,
  };
  const payload = JSON.stringify(args.payload);

  for (const row of rows) {
    try {
      await webPushClient.sendNotification(
        toPushSubscription(row),
        payload,
        { TTL: DEFAULT_PUSH_TTL, ...(row.contentEncoding ? { contentEncoding: row.contentEncoding as ContentEncoding } : {}) },
      );
      result.delivered += 1;
      if (row.failureCount > 0 || row.lastError !== null || row.disabledAt !== null) {
        await db
          .update(pushSubscriptions)
          .set({ failureCount: 0, lastError: null, disabledAt: null, updatedAt: new Date() })
          .where(eq(pushSubscriptions.id, row.id));
      }
    } catch (err) {
      const now = new Date();
      const permanent = isPermanentSubscriptionError(err);
      if (permanent) {
        result.disabled += 1;
      } else {
        result.failed += 1;
      }
      await db
        .update(pushSubscriptions)
        .set({
          failureCount: row.failureCount + 1,
          lastError: describeWebPushError(err),
          disabledAt: permanent ? now : null,
          updatedAt: now,
        })
        .where(eq(pushSubscriptions.id, row.id));
    }
  }

  return result;
}
