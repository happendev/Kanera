import type { dto } from "@kanera/shared";
import type { PersonalNotificationTestResponse } from "@kanera/shared/dto";
import { notificationSettings } from "@kanera/shared/schema";
import { eq } from "drizzle-orm";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { env } from "../../env.js";
import { badRequest } from "../../lib/errors.js";
import type { Locale } from "@kanera/shared/locales";
import { serverMessages } from "../../lib/i18n/messages/index.js";
import { deliverPersonalNotificationTestRow, enqueuePersonalNotification } from "../../lib/push-queue.js";
import { encryptSecret } from "../../lib/secrets.js";
import { assertPersonalNotificationChannelsAllowed } from "../../lib/tier-limits.js";
import { newWebhookSecret } from "../../lib/webhook-signing.js";

export async function rotateWebhookSecret({ auth }: { auth: AuthClaims }): Promise<{ secret: string }> {
  await assertPersonalNotificationChannelsAllowed(auth.cid);
  const [existing] = await db.select().from(notificationSettings).where(eq(notificationSettings.userId, auth.sub)).limit(1);
  if (!existing?.webhookUrl) throw badRequest("configure a webhook URL before rotating its secret");
  const secret = newWebhookSecret();
  await db.update(notificationSettings).set({ encryptedWebhookSecret: encryptSecret(secret), updatedAt: new Date() }).where(eq(notificationSettings.userId, auth.sub));
  return { secret };
}

export async function testPersonalChannel({ auth, channel, locale }: { auth: AuthClaims; channel: dto.PersonalNotificationChannel; locale: Locale }): Promise<PersonalNotificationTestResponse> {
  await assertPersonalNotificationChannelsAllowed(auth.cid);
  // The person testing is the recipient, so the test reads in the language on their screen.
  const m = serverMessages(locale).push.channelTest;
  const row = await enqueuePersonalNotification(db, {
    clientId: auth.cid,
    userId: auth.sub,
    reason: "test",
    channel,
    payload: {
      kind: "test",
      title: m.title,
      body: m.body({ channel }),
      url: `${env.WEB_ORIGIN}/account/settings/notifications`,
      tag: `test:${channel}`,
    },
  }, true);
  const result = await deliverPersonalNotificationTestRow(db, row);
  return { channel, ...result };
}
