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
