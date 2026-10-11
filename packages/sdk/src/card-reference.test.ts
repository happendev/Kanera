import assert from "node:assert/strict";
import test from "node:test";
import { createCardReferenceResolver, isCardReference, parseCardUrl, resolveCardReference } from "./card-reference.js";
import type { KaneraHttpClient } from "./client.js";
import { KaneraApiError } from "./errors.js";

const UUID = "01a04ae9-1526-72ed-9d34-ff4e9cffbe45";
const ORG = "FC6CC2BA92EE24ED";

function fakeHttp(routes: Record<string, unknown>) {
  const requested: string[] = [];
  const http = {
    get(path: string, options?: { query?: Record<string, unknown> }) {
      const key = options?.query ? `${path}?${new URLSearchParams(options.query as Record<string, string>).toString()}` : path;
      requested.push(key);
      if (!(key in routes)) return Promise.reject(new KaneraApiError(404, "NOT_FOUND", "missing"));
      return Promise.resolve(routes[key]);
    },
  } as unknown as KaneraHttpClient;
  return { http, requested };
}

void test("recognises the three accepted card reference forms", () => {
  assert.ok(isCardReference(UUID));
  assert.ok(isCardReference("MKT-42"));
  assert.ok(isCardReference(`https://app.kanera.app/o/${ORG}/c/MKT-42`));
  assert.equal(isCardReference("not a card"), false);
  assert.equal(isCardReference("MKT-0"), false);
});

void test("parses canonical card URLs and rejects lookalikes", () => {
  assert.deepEqual(parseCardUrl(`https://app.kanera.app/o/${ORG}/c/mkt-42`), { organisationKey: ORG, cardKey: "MKT-42" });
  assert.equal(parseCardUrl(`https://app.kanera.app/o/${ORG}/board/MKT-42`), null);
  assert.equal(parseCardUrl("javascript:alert(1)//o/x/c/y"), null);
});

void test("a UUID resolves without any request", async () => {
  const { http, requested } = fakeHttp({});
  assert.equal(await resolveCardReference(http, UUID), UUID);
  assert.deepEqual(requested, []);
});

void test("a canonical URL resolves through its own organisation, not a global search", async () => {
  // Tenant isolation: the URL names the organisation, so there is nothing to disambiguate.
  const { http, requested } = fakeHttp({ [`/api/v1/organisations/${ORG}/cards/by-key/MKT-42`]: { id: UUID } });
  assert.equal(await resolveCardReference(http, `https://app.kanera.app/o/${ORG}/c/MKT-42`), UUID);
  assert.deepEqual(requested, [`/api/v1/organisations/${ORG}/cards/by-key/MKT-42`]);
});

void test("a bare key resolves via search when exactly one organisation owns it", async () => {
  const { http } = fakeHttp({
    "/api/v1/search?q=MKT-42&limit=20": { cards: [{ cardId: UUID, cardKey: "MKT-42", organisationKey: ORG }] },
  });
  assert.equal(await resolveCardReference(http, "MKT-42"), UUID);
});

void test("a lowercase key matches, since keys are compared case-insensitively", async () => {
  // The search term is forwarded as typed (the API matches case-insensitively); the comparison
  // against the returned cardKey is what must not be case-sensitive.
  const { http } = fakeHttp({
    "/api/v1/search?q=mkt-42&limit=20": { cards: [{ cardId: UUID, cardKey: "MKT-42", organisationKey: ORG }] },
  });
  assert.equal(await resolveCardReference(http, "mkt-42"), UUID);
});

void test("a key visible in two organisations is refused rather than guessed at", async () => {
  const other = "01a04ae9-1526-72ed-9d34-ff4e9cffbe46";
  const { http } = fakeHttp({
    "/api/v1/search?q=MKT-42&limit=20": {
      cards: [
        { cardId: UUID, cardKey: "MKT-42", organisationKey: ORG },
        { cardId: other, cardKey: "MKT-42", organisationKey: "AAAAAAAAAAAAAAAA" },
      ],
    },
  });
  const error = await resolveCardReference(http, "MKT-42").catch((e: unknown) => e);
  assert.ok(error instanceof KaneraApiError);
  assert.match(error.message, /ambiguous/u);
});

void test("an incidental search hit is confirmed against its organisation before being accepted", async () => {
  // Search also matches titles and content. A row whose cardKey differs is only a hint about which
  // organisation to ask; it must never be returned as the resolution itself.
  const { http } = fakeHttp({
    "/api/v1/search?q=MKT-42&limit=20": { cards: [{ cardId: "wrong-id", cardKey: "OTHER-9", organisationKey: ORG }] },
    [`/api/v1/organisations/${ORG}/cards/by-key/MKT-42`]: { id: UUID },
  });
  assert.equal(await resolveCardReference(http, "MKT-42"), UUID);
});

void test("an unknown key is a not-found, not a silent undefined", async () => {
  const { http } = fakeHttp({ "/api/v1/search?q=MKT-42&limit=20": { cards: [] } });
  const error = await resolveCardReference(http, "MKT-42").catch((e: unknown) => e);
  assert.ok(error instanceof KaneraApiError);
  assert.ok(error.isNotFound);
});

void test("the resolver caches, so repeating a key in a bulk call costs one lookup", async () => {
  const { http, requested } = fakeHttp({
    "/api/v1/search?q=MKT-42&limit=20": { cards: [{ cardId: UUID, cardKey: "MKT-42", organisationKey: ORG }] },
  });
  const resolve = createCardReferenceResolver(http);
  const ids = await Promise.all(["MKT-42", "mkt-42", " MKT-42 "].map(resolve));
  assert.deepEqual(ids, [UUID, UUID, UUID]);
  assert.equal(requested.length, 1);
});

void test("a failed resolution is not cached, so a later lookup retries once the card exists", async () => {
  // One long-lived SDK instance: the first lookup runs before the card exists (or before access is
  // granted / while the API is unreachable). Remembering that rejection would pin the instance to
  // "not found" forever; only successes are worth memoising.
  const routes: Record<string, unknown> = {};
  const { http, requested } = fakeHttp(routes);
  const resolve = createCardReferenceResolver(http);

  const first = await resolve("MKT-42").catch((e: unknown) => e);
  assert.ok(first instanceof KaneraApiError);
  assert.equal(first.isNotFound, true);

  routes["/api/v1/search?q=MKT-42&limit=20"] = { cards: [{ cardId: UUID, cardKey: "MKT-42", organisationKey: ORG }] };
  assert.equal(await resolve("MKT-42"), UUID);
  assert.equal(requested.filter((path) => path.startsWith("/api/v1/search")).length, 2);

  // Successes still memoise: a third call issues no request.
  assert.equal(await resolve("mkt-42"), UUID);
  assert.equal(requested.filter((path) => path.startsWith("/api/v1/search")).length, 2);
});

/* Browser flows cannot expose a long-lived SDK process's reference-cache growth. These regressions
 * cover eviction resolving the wrong card, eviction discarding a hot entry, UUID traffic displacing
 * useful lookups, and failed/in-flight lookups losing the existing coalescing/retry behavior (above).
 */
void test("large reference streams evict old keys but retain hot references", async () => {
  const requests: string[] = [];
  const http = { get: async (path: string) => { requests.push(path); return { id: path.split("/").at(-1) }; } } as unknown as KaneraHttpClient;
  const resolve = createCardReferenceResolver(http);
  const url = (n: number) => `https://app.kanera.app/o/${ORG}/c/MKT-${n}`;
  for (let n = 1; n <= 1_100; n += 1) {
    assert.equal(await resolve(url(n)), `MKT-${n}`);
    assert.equal(await resolve(url(1)), "MKT-1");
  }
  assert.equal(requests.filter((path) => path.endsWith("/MKT-1")).length, 1);
  assert.equal(await resolve(url(2)), "MKT-2");
  assert.equal(requests.filter((path) => path.endsWith("/MKT-2")).length, 2);
});

void test("UUID streams do not evict useful reference lookups", async () => {
  const { http, requested } = fakeHttp({
    "/api/v1/search?q=MKT-42&limit=20": { cards: [{ cardId: UUID, cardKey: "MKT-42", organisationKey: ORG }] },
  });
  const resolve = createCardReferenceResolver(http);
  assert.equal(await resolve("MKT-42"), UUID);
  for (let n = 0; n < 10_000; n += 1) {
    const uuid = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    assert.equal(await resolve(` ${uuid} `), uuid);
  }
  assert.equal(await resolve("MKT-42"), UUID);
  assert.equal(requested.length, 1);
});
