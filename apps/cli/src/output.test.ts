import assert from "node:assert/strict";
import test from "node:test";
import { render, renderTable } from "./output.js";

void test("renders a table from a list-shaped result and surfaces the cursor", () => {
  const text = render("human", {
    ok: true,
    data: { cards: [{ key: "MKT-1", title: "One" }, { key: "MKT-2", title: "Two" }], nextCursor: "abc" },
  });
  assert.match(text, /KEY\s+TITLE/u);
  assert.match(text, /MKT-2\s+Two/u);
  // A paginated result the caller cannot continue is a silent truncation.
  assert.match(text, /--cursor abc/u);
});

void test("falls back to JSON when the result is not a single list", () => {
  const text = render("human", { ok: true, data: { userId: "u1", scope: "read" } });
  assert.equal((JSON.parse(text) as { scope: string }).scope, "read");
});

void test("quiet mode emits only the data, so it can be piped", () => {
  assert.equal(render("quiet", { ok: true, tool: "kanera_get_session", data: { scope: "read" } }), '{"scope":"read"}');
});

void test("json mode wraps the result in an envelope", () => {
  const envelope = JSON.parse(render("json", { ok: true, tool: "kanera_get_card", data: { id: "c1" } })) as { ok: boolean; tool: string };
  assert.equal(envelope.ok, true);
  assert.equal(envelope.tool, "kanera_get_card");
});

void test("human errors include the code and the hint", () => {
  const text = render("human", { ok: false, error: { code: "FORBIDDEN", message: "nope", hint: "try X", exitCode: 4 } });
  assert.match(text, /\[FORBIDDEN\]: nope/u);
  assert.match(text, /try X/u);
});

void test("structured and human errors preserve retry guidance", () => {
  const envelope = {
    ok: false,
    error: { code: "RATE_LIMITED", message: "slow down", exitCode: 6, retryable: true, retryAfter: "30" },
  } as const;
  assert.match(render("human", envelope), /Retry after: 30/u);
  assert.equal((JSON.parse(render("json", envelope)) as { error: { retryable: boolean } }).error.retryable, true);
});

void test("an empty list says so rather than printing an empty table", () => {
  assert.equal(renderTable([]), "No results.");
});

void test("a created entity carrying one empty collection is not reported as \"No results.\"", () => {
  const text = render("human", {
    ok: true,
    data: { id: "cm1", cardId: "c1", body: "Shipped.", attachments: [], createdAt: "2026-01-01T00:00:00Z" },
  });
  assert.doesNotMatch(text, /No results/u);
  assert.match(text, /Shipped\./u);
});

void test("an empty list payload still reports no results", () => {
  assert.match(render("human", { ok: true, data: { comments: [], nextCursor: null } }), /No results/u);
});

void test("presentation and internal fields are kept out of the table", () => {
  const text = render("human", {
    ok: true,
    data: { boards: [{ name: "Launch", id: "b1", workspaceIcon: "rocket", searchVector: "'x':1A", position: "1000.0" }] },
  });
  assert.match(text, /NAME\s+ID/u);
  assert.doesNotMatch(text, /WORKSPACEICON|SEARCHVECTOR|POSITION/u);
});
