import { z } from "zod";
import { EVENT_OUTBOX_ACTOR_KINDS } from "../schema/event-outbox.js";

export const MCP_CARD_EVENT_NAMES = ["card.created", "card.updated", "card.moved", "comment.created"] as const;
export const MCP_PRIORITY_EVENT_NAME = "priorities.changed";
export const MCP_MY_DAY_EVENT_NAME = "my_day.ready";
// Events addressed to the subscribing user rather than a workspace: they take no arguments and the
// subscription row's targetUserId is always the subscriber (a database check).
export const MCP_USER_EVENT_NAMES = [MCP_PRIORITY_EVENT_NAME, MCP_MY_DAY_EVENT_NAME] as const;
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
export type McpEventData = z.infer<typeof mcpEventData>;
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
export type McpEventOccurrence = McpCardEventOccurrence | McpPriorityEventOccurrence | McpMyDayEventOccurrence;
const descriptions: Record<McpEventName, string> = {
  "card.created": "A card was created in the monitored workspace, board, or card scope.",
  "card.updated": "A card changed, including its title, description, completion or archive state. Read cards.get for the current full record.",
  "card.moved": "A card moved within or between lists or boards. Includes its source and destination lists and previous position.",
  "comment.created": "A new comment was posted on a card. Includes a bounded text excerpt; use comments.list for the full comment.",
  "priorities.changed": "The connected user's own \"Up next\" priority queue may have changed: an entry was added, moved or removed, or a queued card was completed, archived, restored or reassigned. Carries no queue content; call priorities.list for the current ranking.",
  "my_day.ready": "Sent once each weekday morning at the user's daily-digest hour, in their profile time zone, while their daily digest email is enabled. Carries no work content; call work.my_day with the included timeZone.",
};
const cardCatalogEntry = { inputSchema: { ...z.toJSONSchema(mcpEventArguments), dependentRequired: { cardId: ["boardId"] } }, payloadSchema: z.toJSONSchema(mcpEventData) };
const priorityCatalogEntry = { inputSchema: z.toJSONSchema(mcpPriorityEventArguments), payloadSchema: z.toJSONSchema(mcpPriorityEventData) };
const myDayCatalogEntry = { inputSchema: z.toJSONSchema(mcpMyDayEventArguments), payloadSchema: z.toJSONSchema(mcpMyDayEventData) };
export const mcpEventCatalog = MCP_EVENT_NAMES.map((name) => ({
  name, description: descriptions[name], delivery: ["webhook"],
  ...(name === MCP_PRIORITY_EVENT_NAME ? priorityCatalogEntry : name === MCP_MY_DAY_EVENT_NAME ? myDayCatalogEntry : cardCatalogEntry),
}));
