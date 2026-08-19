import { summariseActivityChange } from "@kanera/shared/activity-summary";
import { cardPath } from "@kanera/shared/card-links";
import type { NotificationRow } from "@kanera/shared/dto";
import { NOTIFICATION_REASON, users } from "@kanera/shared/schema";
import { inArray } from "drizzle-orm";
import type { Db } from "../db.js";
import { env } from "../env.js";
import {
  allowsNotificationPush,
  allowsPersonalNotificationChannel,
  allowsWatchedActivityPersonalChannel,
  allowsWatchedActivityPush,
  getNotificationSettingsForUsers,
  getNotificationWorkspaceRulesForUsers,
  isClientPushEnabled,
  type NotificationWorkspaceRuleScope,
} from "./notification-settings.js";
import { enqueuePersonalNotification, enqueuePush } from "./push-queue.js";

type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Push/personal-channel content for one watched-activity notification.
 *
 * A drawer entry states card context in its block header and the action on a separate line. A push
 * banner has only a title and a body, so the card takes the title and the summarised action line
 * becomes the body. The summariser is the same one the drawer uses, so an event reads identically
 * in both places.
 */
export function watchedActivityPushPayload(row: NotificationRow, webOrigin: string) {
  const summary = summariseActivityChange(row);
  const detail = summary.value ? `${summary.text} ${summary.value}` : summary.text;
  return {
    kind: "card_watched_activity",
    title: row.cardTitle ?? row.boardName ?? "Kanera",
    body: `${row.actorName ?? "Someone"} ${detail}`,
    url: new URL(cardPath(row.organisationKey!, row.cardKey!), webOrigin).toString(),
    // One tray entry per card. A watcher on a busy card should see the latest change, not a stack
    // of one notification per event - the delivery layer sets renotify whenever a tag is present,
    // so they are still alerted, but the OS replaces rather than accumulating.
    tag: `card:${row.cardId}:watching`,
  };
}

/**
 * Outbound delivery (web push + the personal channels) for activity on cards and boards the
 * recipient merely watches. Email is deliberately never sent here: watched activity is far too
 * chatty for an inbox, and that asymmetry is the whole reason this is a separate path.
 *
 * Only rows whose reason is `watching` are eligible. `resolveRecipients` assigns exactly one reason
 * per user with precedence watching < assigned < mentioned, so a user who is also an assignee or was
 * mentioned carries that reason instead and is filtered out here - they already receive their push
 * from the assignee/mention pipeline in `assignee-email-notifications.ts`. That single-reason
 * invariant is what guarantees we never double-notify.
 *
 * Actor self-suppression already happened upstream in `resolveRecipients`, so no row reaching this
 * function can belong to the actor. (API-key actors are intentionally not suppressed there, so an
 * integration's owner still gets watched pushes for their own key's actions.)
 */
export async function enqueueWatchedActivityOutbound(
  tx: Tx,
  ctx: { clientId: string; workspaceId: string },
  rows: NotificationRow[],
): Promise<number> {
  const watched = rows.filter((row) =>
    row.reason === NOTIFICATION_REASON.WATCHING
    && row.activity
    && row.cardId
    && row.cardKey
    && row.organisationKey);
  if (watched.length === 0) return 0;

  // Resolve the opt-in before doing any other work. The setting defaults off, so on almost every
  // board this collapses to zero and the remaining queries never run. It also caps the blast radius
  // of RECIPIENT_FANOUT_LIMIT, which allows up to 1000 watchers on one card.
  const userIds = Array.from(new Set(watched.map((row) => row.userId)));
  const settings = await getNotificationSettingsForUsers(tx, userIds);
  const optedIn = userIds.filter((userId) => settings.get(userId)?.watchedActivityOutbound);
  if (optedIn.length === 0) return 0;

  const rules = await getNotificationWorkspaceRulesForUsers(tx, optedIn, [ctx.workspaceId]);
  // Personal channels enqueue under the recipient's own organisation, while web push follows the
  // event's organisation - the same split the assignee pipeline makes, so a cross-organisation
  // guest's ntfy/Gotify/webhook rows stay billed and scoped to their own client.
  const recipientClientIds = new Map(
    (await tx.select({ id: users.id, clientId: users.clientId }).from(users).where(inArray(users.id, optedIn)))
      .map((row) => [row.id, row.clientId] as const),
  );
  const optedInIds = new Set(optedIn);

  let clientPushEnabled: boolean | undefined;
  let enqueued = 0;
  for (const row of watched) {
    if (!optedInIds.has(row.userId)) continue;
    const preference = settings.get(row.userId)!;
    const scope: NotificationWorkspaceRuleScope = { rule: rules.get(row.userId)?.get(ctx.workspaceId) };
    // The drawer emit has already succeeded by the time we get here, so a single row with an
    // unroutable card key must not abort outbound delivery for the remaining recipients.
    let payload: ReturnType<typeof watchedActivityPushPayload>;
    try {
      payload = watchedActivityPushPayload(row, env.WEB_ORIGIN);
    } catch {
      continue;
    }

    for (const channel of ["ntfy", "gotify", "webhook"] as const) {
      if (!allowsWatchedActivityPersonalChannel(preference, channel, scope)) continue;
      if (!preference.personalChannels[channel].configured) continue;
      await enqueuePersonalNotification(tx as Db, {
        clientId: recipientClientIds.get(row.userId) ?? ctx.clientId,
        userId: row.userId,
        reason: "watching",
        channel,
        payload,
      });
      enqueued += 1;
    }

    if (!allowsWatchedActivityPush(preference, scope)) continue;
    if (clientPushEnabled === undefined) clientPushEnabled = await isClientPushEnabled(tx, ctx.clientId);
    if (!clientPushEnabled) continue;
    await enqueuePush(tx as Db, {
      clientId: ctx.clientId,
      userId: row.userId,
      reason: "watching",
      payload,
    });
    enqueued += 1;
  }
  return enqueued;
}

/**
 * Outbound delivery for a watched card going overdue.
 *
 * Overdue takes a different shape from the activity fanout above: its notification rows carry
 * reason `overdue` for watchers and assignees alike, so they are invisible to the `watching` filter,
 * and the caller must pass the watcher subset explicitly. It is also the one case that maps onto a
 * real preference type, so the per-type `cardOverdue` matrix genuinely applies here on top of the
 * opt-in - unlike the typeless activity path, a user can point at the Card overdue row to explain a
 * missing notification.
 *
 * Email is still not sent: assignees keep receiving the overdue email from
 * `enqueueOverdueAssigneeEmails`, watchers only ever get push and personal channels.
 */
export async function enqueueOverdueWatcherOutbound(
  tx: Tx,
  rows: NotificationRow[],
): Promise<number> {
  const eligible = rows.filter((row) => row.cardId && row.cardKey && row.organisationKey);
  if (eligible.length === 0) return 0;

  const userIds = Array.from(new Set(eligible.map((row) => row.userId)));
  const settings = await getNotificationSettingsForUsers(tx, userIds);
  const optedIn = new Set(userIds.filter((userId) => settings.get(userId)?.watchedActivityOutbound));
  if (optedIn.size === 0) return 0;

  const workspaceIds = Array.from(new Set(eligible.map((row) => row.workspaceId)));
  const rules = await getNotificationWorkspaceRulesForUsers(tx, Array.from(optedIn), workspaceIds);
  const recipientClientIds = new Map(
    (await tx.select({ id: users.id, clientId: users.clientId }).from(users).where(inArray(users.id, Array.from(optedIn))))
      .map((row) => [row.id, row.clientId] as const),
  );

  const clientPushEnabled = new Map<string, boolean>();
  let enqueued = 0;
  for (const row of eligible) {
    if (!optedIn.has(row.userId)) continue;
    const preference = settings.get(row.userId)!;
    const scope: NotificationWorkspaceRuleScope = { rule: rules.get(row.userId)?.get(row.workspaceId) };
    const payload = {
      kind: "card_overdue",
      title: "Card overdue",
      body: `${row.cardTitle ?? "A card"} is overdue`,
      url: new URL(cardPath(row.organisationKey!, row.cardKey!), env.WEB_ORIGIN).toString(),
      // Same tag the assignee path uses, so someone who both watches and is assigned still sees a
      // single overdue entry per card rather than two.
      tag: `card:${row.cardId}:overdue`,
    };

    for (const channel of ["ntfy", "gotify", "webhook"] as const) {
      if (!allowsPersonalNotificationChannel(preference, "cardOverdue", channel, scope)) continue;
      if (!preference.personalChannels[channel].configured) continue;
      await enqueuePersonalNotification(tx as Db, {
        clientId: recipientClientIds.get(row.userId) ?? row.clientId,
        userId: row.userId,
        reason: "overdue",
        channel,
        payload,
      });
      enqueued += 1;
    }

    if (!allowsNotificationPush(preference, "cardOverdue", scope)) continue;
    let orgEnabled = clientPushEnabled.get(row.clientId);
    if (orgEnabled === undefined) {
      orgEnabled = await isClientPushEnabled(tx, row.clientId);
      clientPushEnabled.set(row.clientId, orgEnabled);
    }
    if (!orgEnabled) continue;
    await enqueuePush(tx as Db, {
      clientId: row.clientId,
      userId: row.userId,
      reason: "overdue",
      payload,
    });
    enqueued += 1;
  }
  return enqueued;
}
