import type { NotificationWorkspaceRule } from "@kanera/shared/dto";
import type { AuthClaims } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { loadAccessibleBoards } from "../../lib/accessible-boards.js";
import { getNotificationWorkspaceRules, type EffectiveNotificationWorkspaceRule } from "../../lib/notification-settings.js";

function toWorkspaceRuleResponse(rule: EffectiveNotificationWorkspaceRule): NotificationWorkspaceRule {
  return {
    workspaceId: rule.workspaceId,
    paused: rule.paused,
    types: rule.types,
  };
}

export function workspaceRuleMatrixValues(types: NotificationWorkspaceRule["types"]) {
  return {
    cardAssignedEmail: types.cardAssigned.email,
    cardAssignedPush: types.cardAssigned.push,
    cardAssignedNtfy: types.cardAssigned.ntfy,
    cardAssignedGotify: types.cardAssigned.gotify,
    cardAssignedWebhook: types.cardAssigned.webhook,
    cardCommentAddedEmail: types.cardCommentAdded.email,
    cardCommentAddedPush: types.cardCommentAdded.push,
    cardCommentAddedNtfy: types.cardCommentAdded.ntfy,
    cardCommentAddedGotify: types.cardCommentAdded.gotify,
    cardCommentAddedWebhook: types.cardCommentAdded.webhook,
    commentMentionedEmail: types.commentMentioned.email,
    commentMentionedPush: types.commentMentioned.push,
    commentMentionedNtfy: types.commentMentioned.ntfy,
    commentMentionedGotify: types.commentMentioned.gotify,
    commentMentionedWebhook: types.commentMentioned.webhook,
    cardDueDateChangedEmail: types.cardDueDateChanged.email,
    cardDueDateChangedPush: types.cardDueDateChanged.push,
    cardDueDateChangedNtfy: types.cardDueDateChanged.ntfy,
    cardDueDateChangedGotify: types.cardDueDateChanged.gotify,
    cardDueDateChangedWebhook: types.cardDueDateChanged.webhook,
    cardOverdueEmail: types.cardOverdue.email,
    cardOverduePush: types.cardOverdue.push,
    cardOverdueNtfy: types.cardOverdue.ntfy,
    cardOverdueGotify: types.cardOverdue.gotify,
    cardOverdueWebhook: types.cardOverdue.webhook,
    cardReminderEmail: types.cardReminder.email,
    cardReminderPush: types.cardReminder.push,
    cardReminderNtfy: types.cardReminder.ntfy,
    cardReminderGotify: types.cardReminder.gotify,
    cardReminderWebhook: types.cardReminder.webhook,
    reactionAddedEmail: types.reactionAdded.email,
    reactionAddedPush: types.reactionAdded.push,
    reactionAddedNtfy: types.reactionAdded.ntfy,
    reactionAddedGotify: types.reactionAdded.gotify,
    reactionAddedWebhook: types.reactionAdded.webhook,
    cardDependencyEmail: types.cardDependency.email,
    cardDependencyPush: types.cardDependency.push,
    cardDependencyNtfy: types.cardDependency.ntfy,
    cardDependencyGotify: types.cardDependency.gotify,
    cardDependencyWebhook: types.cardDependency.webhook,
  };
}

export async function visibleWorkspaceRuleResponses(auth: AuthClaims): Promise<NotificationWorkspaceRule[]> {
  // The accessible-board catalog includes workspace members, organisation admins, standalone
  // boards, and cross-organisation guests. Using it here keeps settings visibility aligned with
  // the places from which a user can actually receive card notifications.
  const accessibleBoards = await loadAccessibleBoards(auth);
  const workspaceIds = Array.from(new Set(accessibleBoards.map((board) => board.workspaceId)));
  const rules = await getNotificationWorkspaceRules(db, auth.sub, workspaceIds);
  return Array.from(rules.values())
    .map(toWorkspaceRuleResponse)
    .sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));
}
