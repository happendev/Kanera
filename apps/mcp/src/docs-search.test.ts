import assert from "node:assert/strict";
import test from "node:test";
import { KaneraDocsSearch } from "./docs-search.js";

const index = {
  version: 1,
  entries: [
    {
      title: "Board Syncing",
      section: "How a board mirror works",
      url: "https://www.kanera.app/docs/board-syncing#how-a-board-mirror-works",
      text: "A board mirror sends selected source cards to a target board. Existing cards are not copied when the mirror is created.",
    },
    {
      title: "Automations",
      section: "Card enters list",
      url: "https://www.kanera.app/docs/automations#card-enters-list",
      text: "This trigger runs when a card enters a selected workspace list.",
    },
    {
      title: "Roles and Permissions",
      section: "Board roles",
      url: "https://www.kanera.app/docs/user-roles#board-roles",
      text: "Editors can change cards while Observers have read-only access.",
    },
  ],
};

function jsonResponse(body: unknown = index, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), { status: 200, headers });
}

void test("documentation search ranks section matches and returns bounded source excerpts", async () => {
  const search = new KaneraDocsSearch({ fetchImpl: async () => jsonResponse() });
  const result = await search.search("how do board mirrors work", 2);

  assert.equal(result.query, "how do board mirrors work");
  assert.equal(result.results.length, 2);
  assert.deepEqual(result.results[0], {
    title: "Board Syncing",
    section: "How a board mirror works",
    url: "https://www.kanera.app/docs/board-syncing#how-a-board-mirror-works",
    excerpt: "A board mirror sends selected source cards to a target board. Existing cards are not copied when the mirror is created.",
  });
});

void test("documentation search caches, revalidates with ETag, and accepts 304", async () => {
  let now = 0;
  const requests: Array<RequestInit | undefined> = [];
  const search = new KaneraDocsSearch({
    cacheTtlMs: 10,
    now: () => now,
    fetchImpl: async (_input, init) => {
      requests.push(init);
      if (requests.length === 1) return jsonResponse(index, { etag: '"docs-v1"' });
      return new Response(null, { status: 304 });
    },
  });

  await search.search("automations", 5);
  await search.search("automations", 5);
  assert.equal(requests.length, 1);
  now = 11;
  await search.search("automations", 5);
  assert.equal(requests.length, 2);
  assert.equal(new Headers(requests[1]?.headers).get("if-none-match"), '"docs-v1"');
});

void test("documentation search serves stale data when refresh fails", async () => {
  let now = 0;
  let calls = 0;
  const search = new KaneraDocsSearch({
    cacheTtlMs: 10,
    now: () => now,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return jsonResponse();
      throw new Error("offline");
    },
  });

  await search.search("observer", 5);
  now = 11;
  const result = await search.search("observer", 5);
  await search.search("observer", 5);
  assert.equal(calls, 2);
  assert.equal(result.results[0]?.title, "Roles and Permissions");
});

void test("documentation search rejects malformed or untrusted indexes", async () => {
  const search = new KaneraDocsSearch({
    fetchImpl: async () => jsonResponse({
      version: 1,
      entries: [{ title: "Bad", section: null, url: "https://example.com/docs/bad", text: "bad" }],
    }),
  });

  await assert.rejects(() => search.search("bad", 5), (error: unknown) => (
    error instanceof Error
    && "code" in error
    && error.code === "DOCS_UNAVAILABLE"
  ));
});
