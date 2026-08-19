import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allowsDailyDigestEmail,
  allowsNotificationEmail,
  allowsNotificationPush,
  allowsWatchedActivityPersonalChannel,
  allowsWatchedActivityPush,
  defaultNotificationSettings,
  type EffectiveNotificationWorkspaceRule,
} from "./notification-settings.js";

function rule(overrides: Partial<EffectiveNotificationWorkspaceRule> = {}): EffectiveNotificationWorkspaceRule {
  return {
    workspaceId: "workspace-1",
    paused: false,
    types: {
      cardAssigned: { email: true, push: true, ntfy: true, gotify: true, webhook: true },
      cardCommentAdded: { email: true, push: true, ntfy: true, gotify: true, webhook: true },
      commentMentioned: { email: true, push: true, ntfy: true, gotify: true, webhook: true },
      cardDueDateChanged: { email: true, push: true, ntfy: true, gotify: true, webhook: true },
      cardOverdue: { email: true, push: true, ntfy: true, gotify: true, webhook: true },
    },
    ...overrides,
  };
}

void test("workspace notification rules narrow global delivery without overriding global preferences", () => {
  const settings = defaultNotificationSettings("user-1");
  settings.pushEnabled = true;
  const workspaceRule = rule();

  assert.equal(allowsNotificationEmail(settings, "cardAssigned", { rule: workspaceRule }), true);
  assert.equal(allowsDailyDigestEmail(settings, { rule: workspaceRule }), true);

  settings.types.cardAssigned.email = false;
  assert.equal(allowsNotificationEmail(settings, "cardAssigned", { rule: workspaceRule }), false);

  settings.pushEnabled = false;
  assert.equal(allowsNotificationPush(settings, "cardAssigned", { rule: workspaceRule }), false);

  settings.types.cardAssigned.email = true;
  settings.pushEnabled = true;
  const assignmentDisabled = rule({
    types: {
      ...workspaceRule.types,
      cardAssigned: { email: false, push: false, ntfy: false, gotify: false, webhook: false },
    },
  });
  assert.equal(allowsNotificationEmail(settings, "cardAssigned", { rule: assignmentDisabled }), false);
  assert.equal(allowsNotificationPush(settings, "cardAssigned", { rule: assignmentDisabled }), false);
  assert.equal(allowsNotificationEmail(settings, "commentMentioned", { rule: assignmentDisabled }), true);
  assert.equal(allowsDailyDigestEmail(settings, {
    rule: rule({ types: { ...workspaceRule.types, cardOverdue: { ...workspaceRule.types.cardOverdue, email: false } } }),
  }), false);
});

void test("paused and channel-disabled workspace rules suppress delivery while a missing rule inherits", () => {
  const settings = defaultNotificationSettings("user-1");
  assert.equal(allowsNotificationEmail(settings, "commentMentioned"), true);
  assert.equal(allowsNotificationEmail(settings, "commentMentioned", { rule: rule({ paused: true }) }), false);
  assert.equal(allowsNotificationEmail(settings, "commentMentioned", {
    rule: rule({ types: { ...rule().types, commentMentioned: { ...rule().types.commentMentioned, email: false } } }),
  }), false);
});

void test("watched-activity delivery is off by default so watchers are never spammed", () => {
  const settings = defaultNotificationSettings("user-1");
  // Every channel a user could plausibly have enabled, to prove the opt-in alone gates delivery.
  settings.pushEnabled = true;
  settings.ntfyEnabled = true;
  settings.gotifyEnabled = true;
  settings.webhookEnabled = true;

  assert.equal(settings.watchedActivityOutbound, false);
  assert.equal(allowsWatchedActivityPush(settings), false);
  assert.equal(allowsWatchedActivityPersonalChannel(settings, "ntfy"), false);
  assert.equal(allowsWatchedActivityPersonalChannel(settings, "gotify"), false);
  assert.equal(allowsWatchedActivityPersonalChannel(settings, "webhook"), false);
});

void test("watched-activity delivery still respects the channel masters once opted in", () => {
  const settings = defaultNotificationSettings("user-1");
  settings.watchedActivityOutbound = true;

  assert.equal(allowsWatchedActivityPush(settings), false, "push master still off");
  assert.equal(allowsWatchedActivityPersonalChannel(settings, "ntfy"), false, "ntfy master still off");

  settings.pushEnabled = true;
  settings.ntfyEnabled = true;
  assert.equal(allowsWatchedActivityPush(settings), true);
  assert.equal(allowsWatchedActivityPersonalChannel(settings, "ntfy"), true);
  assert.equal(allowsWatchedActivityPersonalChannel(settings, "gotify"), false, "gotify master untouched");
});

void test("a paused workspace rule silences watched activity from that workspace", () => {
  const settings = defaultNotificationSettings("user-1");
  settings.watchedActivityOutbound = true;
  settings.pushEnabled = true;
  settings.ntfyEnabled = true;

  const scope = { rule: rule({ paused: true }) };
  assert.equal(allowsWatchedActivityPush(settings, scope), false);
  assert.equal(allowsWatchedActivityPersonalChannel(settings, "ntfy", scope), false);
});

void test("a workspace rule gates watched activity per channel, not per type", () => {
  const settings = defaultNotificationSettings("user-1");
  settings.watchedActivityOutbound = true;
  settings.pushEnabled = true;

  // Watched activity is a notification reason, not one of the five preference types, so turning off
  // a single type's push column must not silence it - there would be no row in the settings matrix
  // a user could point at to explain the missing notification.
  const oneTypeOff = rule();
  oneTypeOff.types.cardAssigned.push = false;
  assert.equal(allowsWatchedActivityPush(settings, { rule: oneTypeOff }), true);

  // Turning off *every* type for a channel is the rule editor's channel column-header in its
  // unchecked state, which does read as "not this channel, not from here".
  const channelOff = rule();
  for (const type of Object.values(channelOff.types)) type.push = false;
  assert.equal(allowsWatchedActivityPush(settings, { rule: channelOff }), false);
});
