import { z } from "zod";
import { EVENT_OUTBOX_ACTOR_KINDS } from "../schema/event-outbox.js";

export const MCP_EVENT_NAMES = ["card.created", "card.updated", "card.moved", "comment.created"] as const;
export const mcpEventArguments = z.strictObject({
  workspaceId: z.uuid().describe("Workspace UUID owning the boards to monitor."),
  boardId: z.uuid().optional().describe("Only events on this board. Required for board guests."),
  cardId: z.uuid().optional().describe("Only events for this card; requires boardId."),
}).refine((a) => !a.cardId || !!a.boardId, "cardId requires boardId");
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
const identity = {
  name: z.enum(MCP_EVENT_NAMES),
  arguments: mcpEventArguments,
};
export const mcpEventSubscribe = z.strictObject({
  ...identity,
  delivery: z.strictObject({ mode: z.literal("webhook"), url: callbackUrl, secret: mcpSigningSecret }),
  cursor: z.string().nullable().optional(),
  ttlMs: z.number().int().positive().nullable().optional(),
  // Accepted for protocol compatibility; this event catalog deliberately offers no replay.
  maxAgeMs: z.number().int().nonnegative().optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
});
export const mcpEventUnsubscribe = z.strictObject({
  ...identity,
  delivery: z.strictObject({ mode: z.literal("webhook"), url: callbackUrl }),
  _meta: z.record(z.string(), z.unknown()).optional(),
});
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
  listId: z.uuid().optional(), prevPosition: z.string().optional(), url: z.url().optional(),
});
export type McpEventData = z.infer<typeof mcpEventData>;
export type McpEventArguments = z.infer<typeof mcpEventArguments>;
export interface McpEventOccurrence {
  eventId: string;
  name: (typeof MCP_EVENT_NAMES)[number];
  timestamp: string;
  data: McpEventData;
  cursor: null;
}
const descriptions: Record<(typeof MCP_EVENT_NAMES)[number], string> = {
  "card.created": "A card was created in the monitored workspace, board, or card scope.",
  "card.updated": "A card changed, including its title, description, completion or archive state. Read cards.get for the current full record.",
  "card.moved": "A card moved within or between lists or boards. Includes its destination list and previous position.",
  "comment.created": "A new comment was posted on a card. Includes a bounded text excerpt; use comments.list for the full comment.",
};
export const mcpEventCatalog = MCP_EVENT_NAMES.map((name) => ({
  name, description: descriptions[name], delivery: ["webhook"],
  inputSchema: { ...z.toJSONSchema(mcpEventArguments), dependentRequired: { cardId: ["boardId"] } }, payloadSchema: z.toJSONSchema(mcpEventData),
}));
