# MCP events

Kanera implements the webhook subset of [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events) on the authenticated `/mcp` HTTP endpoint. Events are not part of core MCP `2026-07-28`; they follow the draft events extension (SEP-3415). `server/discover` advertises protocol `2026-07-28` and the events capability under both `capabilities.events` (what ChatGPT reads) and `capabilities.extensions["io.modelcontextprotocol/events"]` (where SEP-3415 puts it). `events/list`, `events/subscribe`, and `events/unsubscribe` share API-key/OAuth authentication with tools. Event error codes are `-32011`…`-32015` as ChatGPT documents; SEP-3415 proposes renumbering them.

The endpoint serves both protocol eras through the v2 TypeScript SDK (`@modelcontextprotocol/server` with `createMcpHandler` and the `@modelcontextprotocol/node` adapter), from one per-request server factory. `initialize`-based 2025-era clients are served statelessly. Requests carrying the `2026-07-28` `_meta` envelope get the SDK's spec validation:

- Missing or mismatched `MCP-Protocol-Version`, `Mcp-Method` or `Mcp-Name` headers return `400` with `-32020 HeaderMismatch`.
- A malformed envelope returns `-32602`, and an unknown version returns `400` with `-32022` and `data.supported`.
- Unknown methods, including the removed `ping`, return `404` with `-32601`, and notifications return `202`.
- Results carry `resultType`. Discovery and the tool, prompt and resource-template catalogs set `ttlMs` and `cacheScope: "public"` through the server's `cacheHints`. Resource reads are `ttlMs: 0`, `cacheScope: "private"`, because they return live, credential-scoped data.

The event methods are custom request handlers on the same server (`apps/mcp/src/events.ts`). They are registered and advertised only for `2026-07-28` requests, so 2025-era clients see the same `initialize` response as before. Tool schemas stay pinned to JSON Schema draft-07, as SDK v1 published them, so no client sees a different tool contract. The HTTP layer checks `server/discover` against the public API first, so a revoked credential gets a `401` challenge rather than a capability list. stdio and `kanera mcp` use the SDK's `serveStdio`, which accepts both openings.

Events are HTTP-only.

The catalog exposes `card.created`, `card.updated`, `card.moved`, `comment.created`, and `priorities.changed`. For the card and comment events, arguments require `workspaceId`; optional `boardId`, `listId`, and `cardId` narrow the subscription. `listId` must belong to the workspace; omit `boardId` to monitor that shared list across accessible boards. For `card.moved`, either the source or destination list matches, and moves within the same list are excluded. Other event types match the card’s list. `cardId` requires `boardId`. Workspace lists remain shared across boards. Board guests must supply `boardId`; assigned-items-only guests must also supply a currently visible `cardId`.

For example, subscribe to arrivals and departures for one shared list:

```json
{
  "name": "card.moved",
  "arguments": { "workspaceId": "<workspace UUID>", "listId": "<list UUID>" },
  "delivery": { "mode": "webhook", "url": "https://your-agent.example/events", "secret": "<whsec_ signing key>" }
}
```

Send these parameters to `events/subscribe`. Add `boardId` to restrict the shared list to one board. A departure has `data.fromListId` equal to the watched list; an arrival has `data.listId` equal to it. Reorders within the watched list do not deliver notifications. Refresh and unsubscribe using the same `listId` along with the other identity fields.

`priorities.changed` watches the connected user's own "Up next" queue and takes no arguments (`{}`). Nobody can watch someone else's queue, workspace admins included. Even a content-free ping would tell a watcher when, and by whom, a card they cannot see was completed or reassigned. A database check pins every such subscription's target to its subscriber. The event fires on every change the web app refetches on: an entry added, moved or removed, or a queued card completed, archived, restored or reassigned. Its `data` is only `targetUserId` (the subscriber) and `actor`, with no queue content; call `priorities.list` for the current ranking. These occurrences are enqueued right after the queue write commits rather than from the workspace outbox, which never carries the cross-workspace queue. A crash in that window loses one occurrence, and the next read converges.

```json
{ "name": "priorities.changed", "arguments": {}, "delivery": { "mode": "webhook", "url": "https://your-agent.example/events", "secret": "<whsec_ signing key>" } }
```

Subscriptions are owned by the credential connection, not by the bearer token string. Refreshes and signing-secret changes keep the same deterministic ID. Secrets are encrypted with Kanera's existing secret storage. A connection may hold up to 100 active subscriptions. Lifetime defaults to 24 hours and is capped at 24 hours, including requests for no expiration (`ttlMs: null`). Shorter positive lifetimes are honored. Refresh before the returned `refreshBefore`. Refreshing an active subscription also returns `deliveryStatus` (`active`, `lastDeliveryAt`, `lastError`, and `failedSince` while the endpoint keeps failing). `lastError` is one of the draft's fixed categories and never includes endpoint response content. Delivery is never suspended, so `active` is always true. No replay is offered: `maxAgeMs` is accepted for protocol compatibility, cursors are always null, and renewing an expired subscription starts at the refresh time. Pending deliveries for an active subscription survive process restarts.

Callbacks must use HTTPS, without URL credentials or fragments. Every connection checks public destination addresses and pins the validated address while keeping hostname-based TLS verification; redirects are never followed. The strict callback policy applies in development too. Verification echoes a signed random challenge. It runs before the subscription transaction, so a slow callback host never holds a database connection or the principal's lock. Successful verification is cached for five minutes per credential and callback URL. Every verification failure, including a blocked destination, is reported only as one of the draft's `data.reason` categories. Secret rotation signs with both keys for five minutes.

The existing durable realtime outbox enqueues matching deliveries. Each POST contains one occurrence with a stable outbox-derived `eventId`, occurrence `timestamp`, null `cursor`, and bounded `data`. Card summaries include IDs, title, list (`listId` is the destination and `fromListId` is the source for `card.moved`), and canonical URL when available; comment summaries include the ID and up to 8,000 text characters. Every event includes `actor`: `kind` (`user`, `apiKey`, `agent`, `support`, `automation` or `system`), the `userId` the change was made as, and `self`, which is true only when the subscribing connection made the change: the same OAuth agent grant, the same API key used directly, or the same service OAuth client (a write made with a service client's backing key directly, or through another service client on that key, is not `self`). Personal keys act as their user, so `userId` alone cannot identify an agent's own writes. Automation effects report `automation` even when an agent's write triggered them. Read tools retrieve full current records. These text fields are user data and must not be interpreted as agent instructions.

The worker rechecks the live connection, user, membership, workspace/board access, and guest card visibility before every attempt (once per subscription per batch, plus a per-card check per occurrence). It stops deliveries after expiration or lost access. The MCP queue drains concurrently with the regular webhook queue, and a failure on one row (for example an undecryptable secret) is logged and leaves that row leased for retry without affecting other deliveries. Network/408/425/429/5xx failures are attempted at most five times over about 7.5 minutes (30 s doubling backoff), within the draft's bounded-retry guidance. A response body over 4 KiB is ignored and its status still decides success. HTTP 410, 413 and other permanent 4xx failures stop only that delivery. Each retry keeps the event ID and signs the exact serialized bytes with a fresh timestamp. Successful/permanently failed delivery rows and long-expired subscriptions are cleaned up after 14 days.

After deploying the migration and services, rescan the MCP server in the ChatGPT plugin configuration. In a Work cloud chat, ask to watch a board or card and specify the response to new events. Validate reception, filters, refresh, and stopping monitoring. The event task must avoid feedback loops: read current state before writes and use the tools' `idempotencyKey` for repeatable mutations. Notifications of the task's own writes remain observable; event consumers should check `actor.self` before deciding to write again.

## Verification plan and concrete failure modes

E2E exercises real authentication, MCP 2.0 discovery/catalog/tool calls, header validation, notifications, unknown-method handling, cache fields, callback rejection, and credential revocation through the rendered browser and separate services. It retains Playwright traces and a reproduction command under `e2e/artifacts/`.

The isolated lifecycle tests are necessary because the production callback policy deliberately rejects local test receivers. They substitute only outbound callback I/O and exercise the real HTTP MCP endpoint, public API authorization, migrated PostgreSQL storage and outbox enqueue/delivery. Their failure cases are:

- Discovery advertises events but MCP 2.0 tools cannot execute, or old clients regress.
- Argument order or refresh creates duplicate subscriptions; another credential unsubscribes the owner's stream.
- Callback failure activates a subscription, unsigned verification succeeds, wrong challenge succeeds, or invalid secrets/URLs are accepted.
- List scope misses moves out, includes unrelated moves, delivers reorders, collides with another list subscription, or accepts a list from another workspace.
- Workspace/board/card scope leaks unrelated data; restricted guests receive unassigned content.
- Subscription state or pending deliveries vanish on restart; expired subscriptions receive old events after refresh.
- Revoked keys/grants, suspended users or lost membership still deliver.
- Delivery signatures cover different bytes, use the wrong event ID, lose key rotation, or change the occurrence time on retry.
- Retries duplicate enqueue, exceed the five-attempt budget, retry 410/413, or ignore receiver disappearance.
- Delivery health is not recorded, leaks raw endpoint responses, or resets `failedSince` during a failing streak.
- An event the subscriber's own key caused is not marked `actor.self`.
- `priorities.changed` reaches anyone but the queue's owner (including a workspace admin), accepts a target user, misses a direct or indirect (completion) queue change, or leaks queue content.
- Local/private/metadata/mapped IPv6 destinations, DNS rebinding or redirects bypass destination checks.

Run `pnpm test:e2e -- mcp-events` and `pnpm test:api:integration -- apps/api/src/modules/integrations/mcp-events.itest.ts`. Run MCP's existing tests with `pnpm test:mcp`.
