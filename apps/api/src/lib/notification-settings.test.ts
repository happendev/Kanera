import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allowsDailyDigestEmail,
  allowsNotificationEmail,
  allowsNotificationPush,
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
