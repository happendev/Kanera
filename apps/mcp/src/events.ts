import { ProtocolError, type McpServer, type ServerCapabilities } from "@modelcontextprotocol/server";
import { z } from "zod";
import { KaneraApiError, type KaneraClient } from "./kanera-client.js";

// Event errors follow the draft events extension exactly as ChatGPT documents them
// (developers.openai.com/plugins/build/mcp-events). Core 2026-07-28 calls -32000..-32019 a legacy
// range, and SEP-3415 proposes renumbering these to -32023..-32027; change them only together with
// the clients we ship against, or subscribe failures stop being machine-readable.
const EVENT_NOT_FOUND = -32011;
const EVENT_FORBIDDEN = -32012;
const EVENT_RESOURCE_EXHAUSTED = -32013;
const EVENT_UNSUPPORTED = -32014;
const EVENT_CALLBACK_ENDPOINT = -32015;
const INVALID_PARAMS = -32602;

// The public API owns validation (DTOs in @kanera/shared) and maps failures onto the codes above.
// These schemas only shape params for the SDK; they stay loose so a field the API rejects comes
// back as the API's structured error rather than a generic SDK validation message.
const params = z.looseObject({ _meta: z.record(z.string(), z.unknown()).optional() });
const listParams = z.looseObject({ cursor: z.string().nullable().optional() });

function eventError(cause: unknown): unknown {
  if (!(cause instanceof KaneraApiError)) return cause;
  // KaneraClient retains the structured callback reason without exposing callback secrets.
  if (cause.code === "MCP_CALLBACK_ENDPOINT") return new ProtocolError(EVENT_CALLBACK_ENDPOINT, "CallbackEndpointError", { reason: cause.details?.reason ?? "challenge_failed" });
  if (cause.code === "MCP_EVENT_UNSUPPORTED") return new ProtocolError(EVENT_UNSUPPORTED, "Unsupported", { feature: cause.details?.feature, value: cause.details?.value });
  if (cause.code === "MCP_SUBSCRIPTION_LIMIT") return new ProtocolError(EVENT_RESOURCE_EXHAUSTED, "ResourceExhausted", { limit: "subscriptions", max: cause.details?.max });
  if (cause.code === "MCP_EVENT_NOT_FOUND") return new ProtocolError(EVENT_NOT_FOUND, "NotFound", { kind: "event" });
  if (cause.status === 401 || cause.status === 403) return new ProtocolError(EVENT_FORBIDDEN, "Forbidden");
  // A workspace, board or card named in `arguments` that does not exist is a bad argument,
  // not a missing event type; NotFound's `kind` is reserved for events and subscriptions.
  if (cause.status === 400 || cause.status === 404) return new ProtocolError(INVALID_PARAMS, "InvalidParams", { message: cause.message });
  if (cause.status === 429) return new ProtocolError(EVENT_RESOURCE_EXHAUSTED, "ResourceExhausted");
  return cause;
}

/**
 * The webhook subset of the draft MCP events extension (see MCP_EVENTS.md). Subscriptions,
 * verification, signing and delivery all live in the public API so the worker can deliver from the
 * durable outbox; these handlers only relay the authenticated caller's requests to it.
 */
export function registerKaneraEvents(server: McpServer, api: () => KaneraClient) {
  // `events` is the key ChatGPT reads today; the extensions entry is where SEP-3415 moves it.
  // Advertising both lets either generation of client find the same catalog. The SDK's
  // ServerCapabilities type predates the draft, so the top-level key needs a cast.
  server.server.registerCapabilities({ events: {}, extensions: { "io.modelcontextprotocol/events": {} } } as ServerCapabilities);
  server.server.setRequestHandler("events/list", { params: listParams }, async ({ cursor }) => {
    // The catalog is a single page; any non-empty cursor can only be stale or forged.
    if (cursor != null && cursor !== "") throw new ProtocolError(INVALID_PARAMS, "Invalid event catalog cursor");
    try { return await api().get<Record<string, unknown>>("mcp-events"); } catch (cause) { throw eventError(cause); }
  });
  for (const action of ["subscribe", "unsubscribe"] as const) {
    server.server.setRequestHandler(`events/${action}`, { params }, async ({ _meta: _ignored, ...body }) => {
      try { return await api().post<Record<string, unknown>>(`mcp-events/${action}`, body); } catch (cause) { throw eventError(cause); }
    });
  }
}
