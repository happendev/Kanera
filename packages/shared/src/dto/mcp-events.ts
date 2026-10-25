import { z } from "zod";
import { EVENT_OUTBOX_ACTOR_KINDS } from "../schema/event-outbox.js";

// The schedule events come from the server-side schedule engine, not from a single write: after a
// date, relation, completion or archive change on a board the engine runs again and reports what
// changed against its last verdict, so a chain of edits yields one event per card, not one per edit.
export const MCP_CARD_EVENT_NAMES = ["card.created", "card.updated", "card.moved", "comment.created", "card.blocked", "card.unblocked", "schedule.conflict_detected", "schedule.conflict_resolved", "schedule.critical_path_slipped"] as const;
export const MCP_PRIORITY_EVENT_NAME = "priorities.changed";
export const MCP_MY_DAY_EVENT_NAME = "my_day.ready";
export const MCP_REMINDER_EVENT_NAME = "reminder.due";
// Events addressed to the subscribing user rather than a workspace: they take no arguments and the
// subscription row's targetUserId is always the subscriber (a database check).
export const MCP_USER_EVENT_NAMES = [MCP_PRIORITY_EVENT_NAME, MCP_MY_DAY_EVENT_NAME, MCP_REMINDER_EVENT_NAME] as const;
export type McpUserEventName = (typeof MCP_USER_EVENT_NAMES)[number];
export const MCP_EVENT_NAMES = [...MCP_CARD_EVENT_NAMES, ...MCP_USER_EVENT_NAMES] as const;
export function isMcpUserEventName(name: string): name is McpUserEventName {
  return (MCP_USER_EVENT_NAMES as readonly string[]).includes(name);
}
export type McpEventName = (typeof MCP_EVENT_NAMES)[number];
export const mcpEventArguments = z.strictObject({
  workspaceId: z.uuid().describe("Workspace UUID owning the boards to monitor."),
  boardId: z.uuid().optional().describe("Only events on this board. Required for board guests."),
  listId: z.uuid().optional().describe("Workspace list UUID. Card moves match entry or exit from this list, excluding reorders within it; other events match the card list."),
  cardId: z.uuid().optional().describe("Only events for this card; requires boardId."),
}).refine((a) => !a.cardId || !!a.boardId, "cardId requires boardId");
// Always the connected user's own "Up next" queue, so there is nothing to choose. Watching a
// teammate's queue is deliberately not offered: even a content-free ping would tell an admin when,
// and by whom, a card they cannot see was completed or reassigned.
export const mcpPriorityEventArguments = z.strictObject({});
// Always the connected user's own day; same empty shape as the queue event.
export const mcpMyDayEventArguments = mcpPriorityEventArguments;
const callbackUrl = z.url().max(2048).refine((url) => {
  const parsed = new URL(url);
  return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.hash;
}, "callback must be HTTPS without credentials or fragment");
export const mcpSigningSecret = z.string().min(38).max(94).regex(/^whsec_[A-Za-z0-9+/]+={0,2}$/u).refine((s) => {
  const encoded = s.slice(6);
  try {
    const bytes = atob(encoded);
    return bytes.length >= 24 && bytes.length <= 64 && btoa(bytes).replace(/=+$/u, "") === encoded.replace(/=+$/u, "");
  } catch { return false; }
}, "signing key must be 24–64 bytes of base64");
// Each event family has its own argument shape; `name` selects which one applies.
const identities = [
  { name: z.enum(MCP_CARD_EVENT_NAMES), arguments: mcpEventArguments },
  { name: z.enum(MCP_USER_EVENT_NAMES), arguments: mcpPriorityEventArguments },
] as const;
const subscribeRest = {
  delivery: z.strictObject({ mode: z.literal("webhook"), url: callbackUrl, secret: mcpSigningSecret }),
  cursor: z.string().nullable().optional(),
  ttlMs: z.number().int().positive().nullable().optional(),
  // Accepted for protocol compatibility; this event catalog deliberately offers no replay.
  maxAgeMs: z.number().int().nonnegative().optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
};
const unsubscribeRest = {
  delivery: z.strictObject({ mode: z.literal("webhook"), url: callbackUrl }),
  _meta: z.record(z.string(), z.unknown()).optional(),
};
export const mcpEventSubscribe = z.discriminatedUnion("name", [
  z.strictObject({ ...identities[0], ...subscribeRest }),
  z.strictObject({ ...identities[1], ...subscribeRest }),
]);
export const mcpEventUnsubscribe = z.discriminatedUnion("name", [
  z.strictObject({ ...identities[0], ...unsubscribeRest }),
  z.strictObject({ ...identities[1], ...unsubscribeRest }),
]);
// Agents reacting to events can otherwise loop on their own writes: personal credentials act as the
// human, so userId alone cannot separate "I did this" from "my user did this". `self` is computed
// per subscription and is true only when the subscribing connection made the change.
export const mcpEventActor = z.strictObject({
  kind: z.enum(EVENT_OUTBOX_ACTOR_KINDS).describe("user (web app), apiKey, agent (OAuth agent grant), support, automation, or system."),
  userId: z.uuid().nullable().describe("The user the change was made as; null for automation and system changes."),
  self: z.boolean().describe("True when the subscribing connection itself made this change."),
});
export const mcpEventData = z.strictObject({
  workspaceId: z.uuid(), boardId: z.uuid(), cardId: z.uuid(), actor: mcpEventActor,
  title: z.string().optional(), text: z.string().optional(), commentId: z.uuid().optional(),
  listId: z.uuid().optional(), fromListId: z.uuid().optional(), prevPosition: z.string().optional(), url: z.url().optional(),
  // schedule.* only.
  blockerCardId: z.uuid().optional().describe("schedule.conflict_*: the open blocker planned to finish on or after this card's start."),
  days: z.number().int().optional().describe("schedule.conflict_detected: working days the card would have to move right; schedule.critical_path_slipped: working days the projected finish moved."),
  projectedFinish: z.iso.date().optional().describe("schedule.critical_path_slipped: the chain's new projected finish."),
  previousProjectedFinish: z.iso.date().optional(),
  slipDays: z.number().int().optional().describe("schedule.critical_path_slipped: working days the projected finish lands after the latest due date."),
});
// Deliberately content-free, like the web app's `cardPriority:invalidated` ping: the queue is a
// per-viewer redacted projection (entries the reader cannot see keep their rank as card: null), so
// the subscriber re-reads it with priorities.list under its own credentials instead.
export const mcpPriorityEventData = z.strictObject({
  targetUserId: z.uuid().describe("The connected user, whose queue changed. Read it with priorities.list."),
  actor: mcpEventActor,
});
// A scheduled morning ping, sent at the daily-digest hour on weekdays to users whose digest email is
// enabled. Content-free for the same reason as the queue event: the subscriber reads work.my_day
// under its own credentials, so access is decided at read time, never at enqueue time.
export const mcpMyDayEventData = z.strictObject({
  targetUserId: z.uuid().describe("The connected user. Read their day with work.my_day."),
  localDate: z.iso.date().describe("The user's local date (YYYY-MM-DD) this ping is for."),
  timeZone: z.string().describe("The user's profile time zone; pass it to work.my_day."),
  actor: mcpEventActor,
});
// Fired when one of the connected user's own card reminders comes due. Like the other user events it
// names the card but carries none of its content: the subscriber reads it with cards.get under its
// own credentials, so a card the user has since lost access to is never described by the ping.
export const mcpReminderEventData = z.strictObject({
  targetUserId: z.uuid().describe("The connected user, who set the reminder."),
  reminderId: z.uuid(),
  cardId: z.uuid().describe("The reminded card. Read it with cards.get."),
  remindAt: z.iso.datetime({ offset: true }).describe("The instant the reminder was scheduled for."),
  url: z.url().optional().describe("Canonical web link to the card."),
  actor: mcpEventActor,
});
export type McpEventData = z.infer<typeof mcpEventData>;
export type McpReminderEventData = z.infer<typeof mcpReminderEventData>;
export type McpMyDayEventData = z.infer<typeof mcpMyDayEventData>;
export type McpPriorityEventData = z.infer<typeof mcpPriorityEventData>;
export type McpEventArguments = z.infer<typeof mcpEventArguments>;
export type McpPriorityEventArguments = z.infer<typeof mcpPriorityEventArguments>;
export type McpStoredEventArguments = McpEventArguments | McpPriorityEventArguments;
interface McpOccurrenceBase {
  eventId: string;
  timestamp: string;
  cursor: null;
}
export type McpCardEventOccurrence = McpOccurrenceBase & { name: (typeof MCP_CARD_EVENT_NAMES)[number]; data: McpEventData };
export type McpPriorityEventOccurrence = McpOccurrenceBase & { name: typeof MCP_PRIORITY_EVENT_NAME; data: McpPriorityEventData };
export type McpMyDayEventOccurrence = McpOccurrenceBase & { name: typeof MCP_MY_DAY_EVENT_NAME; data: McpMyDayEventData };
export type McpReminderEventOccurrence = McpOccurrenceBase & { name: typeof MCP_REMINDER_EVENT_NAME; data: McpReminderEventData };
export type McpEventOccurrence = McpCardEventOccurrence | McpPriorityEventOccurrence | McpMyDayEventOccurrence | McpReminderEventOccurrence;
const descriptions: Record<McpEventName, string> = {
  "card.created": "A card was created in the monitored workspace, board, or card scope.",
  "card.updated": "A card changed, including its title, description, completion or archive state. Read cards.get for the current full record.",
  "card.blocked": "An active card gained its first open blocker, including a blocker being reopened or restored. Additional blockers do not repeat this event. Includes people, integrations, automations and mirrors; independent of configured automation rules.",
  "card.unblocked": "An active card lost its last open blocker through completion, archive or unlinking, or the blocker's board or list being deleted. Includes people, integrations, automations and mirrors; independent of configured automation rules.",
  "schedule.conflict_detected": "An open card gained its first scheduling conflict: an open blocker is now planned to finish on or after the card's planned start. Includes blockerCardId and the working days (days) the card would have to move. Computed by the same engine as the Timeline view; independent of configured automation rules.",
  "schedule.conflict_resolved": "An open card lost its last scheduling conflict, through a date change, the blocker completing or the dependency being removed.",
  "schedule.critical_path_slipped": "A card on its board's critical path was rescheduled so the chain's projected finish moved later. Includes the previous and new projectedFinish and slipDays against the latest due date. Fires for the card whose dates moved.",
  "card.moved": "A card moved within or between lists or boards. Includes its source and destination lists and previous position.",
  "comment.created": "A new comment was posted on a card. Includes a bounded text excerpt; use comments.list for the full comment.",
  "priorities.changed": "The connected user's own \"Up next\" priority queue may have changed: an entry was added, moved or removed, or a queued card was completed, archived, restored or reassigned. Carries no queue content; call priorities.list for the current ranking.",
  "reminder.due": "Sent when one of the connected user's own card reminders (cards.set_reminder) comes due, at most once per reminder. Carries the card id but no card content; call cards.get for the card.",
  "my_day.ready": "Sent once each weekday morning at the user's daily-digest hour, in their profile time zone, while their daily digest email is enabled. Carries no work content; call work.my_day with the included timeZone.",
};
const cardCatalogEntry = { inputSchema: { ...z.toJSONSchema(mcpEventArguments), dependentRequired: { cardId: ["boardId"] } }, payloadSchema: z.toJSONSchema(mcpEventData) };
const priorityCatalogEntry = { inputSchema: z.toJSONSchema(mcpPriorityEventArguments), payloadSchema: z.toJSONSchema(mcpPriorityEventData) };
const myDayCatalogEntry = { inputSchema: z.toJSONSchema(mcpMyDayEventArguments), payloadSchema: z.toJSONSchema(mcpMyDayEventData) };
const reminderCatalogEntry = { inputSchema: z.toJSONSchema(mcpPriorityEventArguments), payloadSchema: z.toJSONSchema(mcpReminderEventData) };
export const mcpEventCatalog = MCP_EVENT_NAMES.map((name) => ({
  name, description: descriptions[name], delivery: ["webhook"],
  ...(name === MCP_PRIORITY_EVENT_NAME ? priorityCatalogEntry
    : name === MCP_MY_DAY_EVENT_NAME ? myDayCatalogEntry
    : name === MCP_REMINDER_EVENT_NAME ? reminderCatalogEntry
    : cardCatalogEntry),
}));
