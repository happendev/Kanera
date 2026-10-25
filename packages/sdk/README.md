# `@kanera/sdk`

TypeScript client for the Kanera public API. No runtime dependencies; built on global `fetch`, so it
runs unchanged on Node 18+, Bun, Deno, Cloudflare Workers, and browsers.

```bash
npm install @kanera/sdk
```

```ts
import { Kanera } from "@kanera/sdk";

const kanera = new Kanera({ apiKey: process.env.KANERA_API_KEY! });

const session = await kanera.session();
if (session.scope === "read") throw new Error("this credential cannot write");

for await (const card of kanera.work.iterateCards()) {
  console.log(card.key, card.title);
}

await kanera.cards.setCompletion("MKT-42", true);
await kanera.comments.create("MKT-42", { body: "Shipped in 1.4.0." });
```

## Getting an API key

Create a key in the Kanera web app under **Settings → API keys**. Two kinds exist:

- **Personal keys** (`kanera_u_…`) act as you, across everything you can access. Each key is
  scoped **read-only** or **read-write** at creation — read-only is the safe choice for reporting
  jobs and AI agents.
- **Workspace keys** (created in workspace settings) are tied to a workspace rather than a person,
  so they survive people leaving and are the right shape for long-lived integrations.

Keys are shown once at creation. Keep them out of source control — read from the environment:

```ts
const kanera = new Kanera({ apiKey: process.env.KANERA_API_KEY! });
```

Self-hosting? Point the client at your deployment:

```ts
const kanera = new Kanera({ apiKey, baseUrl: "https://api.your-kanera.example" });
```

## Bootstrapping a workspace

One request creates a workspace with its shared lists, custom fields, labels, checklist templates,
starter cards, automations, and a first board. Seed content refers to lists, labels, and fields by
name. This needs an organisation admin using a **personal** key; workspace keys are refused.

```ts
const workspace = await kanera.workspaces.create({
  name: "Marketing",
  lists: [{ name: "Ideas" }, { name: "In progress" }, { name: "Done" }],
  labels: [{ name: "Campaign", color: "blue" }],
  initialBoard: { name: "Q4 launch" },
});

// A standalone board is a hidden one-board workspace with its own lists and fields.
const solo = await kanera.workspaces.create({
  kind: "board",
  name: "Reading list",
  initialBoard: { name: "Reading list" },
  lists: [{ name: "To read" }, { name: "Read" }],
});

await kanera.boards.create(workspace.id, { name: "Events" });
```

## Board separators

Separators are first-class, board-owned items in a workflow list's ordering lane. They can carry a
title and color, and their anchors can target either cards or other separators.

```ts
const separator = await kanera.separators.create(boardId, listId, {
  title: "This week",
  color: "blue",
  anchor: { side: "before", item: { type: "card", id: cardId } },
});

await kanera.cards.move("MKT-42", {
  listId,
  anchor: { side: "after", item: { type: "separator", id: separator.id } },
});
```

## Dependencies

Cards in the same workspace can block each other or simply be related. Direction reads from the
first card's side, and a relation that would create a blocking cycle is rejected.

```ts
await kanera.cards.addRelation("API-12", "WEB-40", "blocks"); // WEB-40 is blocked by API-12

const { relations, hiddenBlockerCount } = await kanera.cards.listRelations("WEB-40");
const blocker = relations.find((relation) => relation.direction === "blocked_by");
if (blocker) await kanera.cards.removeRelation("WEB-40", blocker.id);
```

`hiddenBlockerCount` counts open blockers on boards you cannot open; they are never listed.

To see whole chains at once, across boards, read the dependency map for one card, a board or a
workspace:

```ts
const map = await kanera.cards.dependencyGraph({ cards: ["WEB-40"] }); // or { boardId } / { workspaceId }
const card = map.cards.find((entry) => entry.key === "WEB-40");
const blockerIds = map.edges
  .filter((edge) => edge.kind === "blocks" && edge.targetCardId === card?.id)
  .map((edge) => edge.sourceCardId);
```

The map follows `blocks` relations both ways through open cards you can open, includes completed
blockers where a chain reaches them, and stops at 400 cards (`truncated`). Cards on boards you
cannot open are never included; `blockedByCount` still counts them.

## Schedules

The map says who blocks whom. For when work finishes, how much room each card has and what slips,
read the schedule the Timeline view draws, computed by the same critical-path engine:

```ts
const schedule = await kanera.work.schedule({ boardId }); // or { workspaceId }
const { projectedFinish, latestDue, slipDays, conflictCount } = schedule.summary;
const critical = schedule.cards.filter((card) => card.critical);
const atRisk = schedule.cards.filter((card) => card.conflicts.length > 0);
```

Every date is a working day (Mon–Fri). `slackDays` is the working days a card can slip before it
delays the end of its chain; a `critical` card has none. A conflict is an open blocker planned to
finish on or after the card's planned start, with the `days` the card would have to move right.
`summary.slipDays` is how far `projectedFinish` lands after `latestDue`; 0 means the plan holds.

For a morning briefing, `kanera.work.scheduleAttention({ limit: 10 })` returns the credential
owner's own cards with conflicts and their critical-path cards, across every board they are
assigned on. Apply a reschedule with `kanera.cards.update(card, { startDateLocalDate, dueDateLocalDate })`,
keeping the start on or before the due date.

## Card references

Anywhere a card is named, you may pass a UUID, a human key such as `MKT-42`, or a canonical card
URL. Keys are resolved once per client and cached, so repeating one across a bulk operation costs a
single lookup.

A key prefix is unique only inside an organisation, and a personal credential can see several. A key
visible in more than one is **rejected**, not guessed at — pass the canonical URL or the UUID to
disambiguate.

## Check the scope first

```ts
const { scope } = await kanera.session();
```

`read` means every mutation will be refused with a `FORBIDDEN` error. Checking once at start-up is
cheaper than discovering it halfway through a migration.

## Pagination

Every list endpoint is bounded — there is no "give me the whole board" call. The common integration
bug is reading page one and treating it as the whole set, so iteration is the default shape:

```ts
for await (const board of kanera.boards.iterate()) { /* … */ }

const firstFifty = await kanera.comments.iterate("MKT-42").all(50);

// Or drive the pages yourself.
let cursor: string | undefined;
do {
  const page = await kanera.comments.list("MKT-42", { cursor });
  cursor = page.nextCursor ?? undefined;
} while (cursor);
```

## Errors

```ts
import { KaneraApiError } from "@kanera/sdk";

try {
  await kanera.cards.update("MKT-42", { title: "New" });
} catch (error) {
  if (error instanceof KaneraApiError && error.isForbidden) {
    // A read-only credential, or no editor access to this board. Retrying will not help.
  }
}
```

`KaneraApiError` carries `status`, the API's stable `code`, and guards for the cases worth
branching on: `isUnauthenticated`, `isForbidden`, `isNotFound`, `isRateLimited`, `isRetryable`.
Transport failures raise `KaneraConnectionError`.

## Retries and idempotency

Reads and `DELETE`/`PUT` are retried automatically on rate limits and transient upstream failures,
with exponential backoff, full jitter, and `Retry-After` honoured when the server sends it.

**Mutations are not retried unless you supply an idempotency key**, because a retry after an
ambiguous failure would create a second card or post a second comment. Supply one and the API
replays the first outcome instead of repeating the write:

```ts
await kanera.comments.create("MKT-42", { body: "Deployed." }, {
  idempotencyKey: crypto.randomUUID(),
});
```

## Webhooks

```ts
import { parseWebhook } from "@kanera/sdk";

app.post("/kanera", async (req, res) => {
  const event = await parseWebhook({
    secret: process.env.KANERA_WEBHOOK_SECRET!,
    payload: req.rawBody,   // the exact bytes; re-serialised JSON will not verify
    headers: req.headers,
  });
  // event.type, event.workspaceId, event.data
});
```

`parseWebhook` throws rather than returning a boolean, so a handler cannot forget to check before
using the payload. The signature covers `{timestamp}.{body}`, and the timestamp is checked against a
5-minute window (configurable) to bound replay.

Endpoints can be registered from the API as well as from Workspace Settings. A workspace admin
manages every endpoint; any other write-capable credential that is a workspace member can register
endpoints scoped to its own connection, which is how an agent subscribes without admin authority:

```ts
const endpoint = await kanera.webhookEndpoints.create(workspaceId, {
  name: "My agent",
  url: "https://agent.example.com/kanera",
  eventTypes: ["card:created", "comment:created"], // [] for everything
});
// endpoint.secret is shown once; keep it for parseWebhook.
```

## Options

```ts
new Kanera({
  apiKey,
  baseUrl: "https://api.kanera.app", // your own origin when self-hosting
  timeoutMs: 30_000,
  maxRetries: 2,
  organisationId,                     // pin identity-wide personal credentials to one organisation
  userAgent: "acme-sync/2.1",         // appended to the SDK's own User-Agent
  onRetry: ({ attempt, delayMs }) => log.warn({ attempt, delayMs }),
  fetch: myFetch,                     // supply your own agent or proxy
});
```

## Escape hatch

The API moves faster than the typed surface. Nothing is gated behind a wrapper:

```ts
const result = await kanera.http.post<MyType>("/api/v1/some/new/endpoint", body);
```

## A note on browsers

The package runs in a browser, but using it there means shipping an API key to the client. Only do
that in a trusted first-party context — for anything user-facing, call Kanera from your server.

## License

[MIT](LICENSE). The SDK is deliberately more permissive than the Kanera server (Elastic License
2.0), so embedding it in your application raises no license-policy questions.
