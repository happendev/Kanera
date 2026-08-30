import assert from "node:assert/strict";
import test from "node:test";
import { paginateCursor, paginateOffset } from "./pagination.js";

void test("cursor pagination follows nextCursor until it is null", async () => {
  const pages = [
    { items: ["a", "b"], nextCursor: "c1" },
    { items: ["c"], nextCursor: null },
  ];
  const seen: (string | undefined)[] = [];
  const iterator = paginateCursor<string>((cursor) => {
    seen.push(cursor);
    return Promise.resolve(pages[seen.length - 1]!);
  });
  assert.deepEqual(await iterator.all(), ["a", "b", "c"]);
  assert.deepEqual(seen, [undefined, "c1"]);
});

void test("offset pagination stops on a short page without an extra request", async () => {
  // There is no total count to compare against, so a short page is the only end-of-set signal.
  let requests = 0;
  const iterator = paginateOffset<number>((limit, offset) => {
    requests += 1;
    return Promise.resolve(offset === 0 ? [1, 2] : []);
  }, 2);
  assert.deepEqual(await iterator.all(), [1, 2]);
  assert.equal(requests, 2);
});

void test("offset pagination stops immediately when a page is not full", async () => {
  let requests = 0;
  const iterator = paginateOffset<number>(() => {
    requests += 1;
    return Promise.resolve([1]);
  }, 5);
  assert.deepEqual(await iterator.all(), [1]);
  assert.equal(requests, 1);
});

void test("all(limit) stops fetching once it has enough", async () => {
  let requests = 0;
  const iterator = paginateCursor<number>(() => {
    requests += 1;
    return Promise.resolve({ items: [requests, requests], nextCursor: "more" });
  });
  assert.deepEqual(await iterator.all(3), [1, 1, 2]);
  assert.equal(requests, 2);
});

void test("for await yields individual items across page boundaries", async () => {
  let page = 0;
  const iterator = paginateCursor<string>(() => {
    page += 1;
    return Promise.resolve({ items: [`p${page}a`, `p${page}b`], nextCursor: page < 2 ? "next" : null });
  });
  const collected: string[] = [];
  for await (const item of iterator) collected.push(item);
  assert.deepEqual(collected, ["p1a", "p1b", "p2a", "p2b"]);
});
