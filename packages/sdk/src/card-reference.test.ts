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
