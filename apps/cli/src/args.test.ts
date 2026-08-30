import assert from "node:assert/strict";
import test from "node:test";
import { expandFlagPaths, parseArgs, stringFlag } from "./args.js";

void test("parses command paths, values, and bare booleans", () => {
  const parsed = parseArgs(["card", "done", "MKT-42", "--json", "--profile", "agent"]);
  assert.deepEqual(parsed.positionals, ["card", "done", "MKT-42"]);
  assert.equal(parsed.flags.json, true);
  assert.equal(parsed.flags.profile, "agent");
});

void test("accepts --flag=value and --no-flag", () => {
  const parsed = parseArgs(["work", "--limit=10", "--no-archived"]);
  assert.equal(parsed.flags.limit, "10");
  assert.equal(parsed.flags.archived, false);
});

void test("repeating a flag builds an array", () => {
  const parsed = parseArgs(["work", "--boardIds", "a", "--boardIds", "b"]);
  assert.deepEqual(parsed.flags.boardIds, ["a", "b"]);
});

void test("only -- prefixed tokens terminate a flag, so keys and negatives survive as values", () => {
  const parsed = parseArgs(["card", "--cardId", "MKT-42", "--offset", "-5"]);
  assert.equal(parsed.flags.cardId, "MKT-42");
  assert.equal(parsed.flags.offset, "-5");
});

void test("-- stops flag parsing", () => {
  const parsed = parseArgs(["comment", "MKT-1", "--", "--not-a-flag"]);
  assert.deepEqual(parsed.positionals, ["comment", "MKT-1", "--not-a-flag"]);
});

void test("dotted and bracketed names expand into a nested payload", () => {
  const payload = expandFlagPaths({
    "changes.title": "New",
    "changes.description": "Body",
    "scope.boardIds[]": "one",
    json: true,
    profile: "agent",
  });
  assert.deepEqual(payload, {
    changes: { title: "New", description: "Body" },
    scope: { boardIds: ["one"] },
  });
});

void test("global flags never leak into tool arguments", () => {
  assert.deepEqual(expandFlagPaths({ json: true, quiet: true, "api-key": "k", url: "u", profile: "p" }), {});
});

void test("stringFlag ignores booleans and takes the last repeat", () => {
  assert.equal(stringFlag({ profile: true }, "profile"), undefined);
  assert.equal(stringFlag({ profile: ["a", "b"] }, "profile"), "b");
});
