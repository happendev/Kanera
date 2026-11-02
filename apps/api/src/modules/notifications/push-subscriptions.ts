import type { dto } from "@kanera/shared";
import type { PushTestResponse } from "@kanera/shared/dto";
import { PUSH_QUEUE_STATUS, pushQueue } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import type { Locale } from "@kanera/shared/locales";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { serverMessages } from "../../lib/i18n/messages/index.js";
import { deliverPushRow, enqueuePushImmediate } from "../../lib/push-queue.js";
import { upsertPushSubscriptionForUser } from "../../lib/web-push.js";

export async function savePushSubscription({
  auth,
  body,
  userAgentHeader,
}: {
  auth: AuthClaims;
  body: dto.PushSubscriptionBody;
  userAgentHeader: string | string[] | undefined;
}): Promise<void> {
  const userAgent = Array.isArray(userAgentHeader) ? userAgentHeader.join(" ") : userAgentHeader;
  await upsertPushSubscriptionForUser({
    clientId: auth.cid,
    userId: auth.sub,
    subscription: body,
    userAgent,
  });
}

export async function testPush({ auth, body, locale }: { auth: AuthClaims; body: dto.PushTestBody; locale: Locale }): Promise<PushTestResponse> {
  const m = serverMessages(locale).push.test;
  const row = await enqueuePushImmediate(db, {
    clientId: auth.cid,
    userId: auth.sub,
    reason: "test",
    payload: { ...body, title: body.title ?? m.title, body: body.body ?? m.body },
  });
  const result = await deliverPushRow(db, row);
  const attempted = result.delivered + result.disabled + result.failed;
  const now = new Date();
  // This endpoint intentionally tests the provider synchronously, but its durable audit row must
  // still reach a terminal state instead of looking like a worker-stranded delivery.
  await db.update(pushQueue).set({
    status: result.delivered > 0 && result.failed === 0 ? PUSH_QUEUE_STATUS.success : PUSH_QUEUE_STATUS.error,
    sentAt: result.delivered > 0 ? now : null,
    lastError: result.failed > 0 || result.delivered === 0
      ? `delivered=${result.delivered} disabled=${result.disabled} failed=${result.failed}`
      : null,
    processingLeaseExpiresAt: null,
    updatedAt: now,
  }).where(eq(pushQueue.id, row.id));
  return {
    attempted,
    delivered: result.delivered,
    disabled: result.disabled,
    failed: result.failed,
  };
}
