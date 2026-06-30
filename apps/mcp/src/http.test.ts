import assert from "node:assert/strict";
import test from "node:test";
import { mcpRequestPathname } from "./http.js";

void test("MCP route parsing ignores query strings", () => {
  assert.equal(mcpRequestPathname("/mcp?session=abc"), "/mcp");
});

void test("health route parsing ignores query strings", () => {
  assert.equal(mcpRequestPathname("/health?probe=1"), "/health");
});

void test("unrelated route parsing stays unrelated", () => {
  assert.equal(mcpRequestPathname("/elsewhere?probe=1"), "/elsewhere");
});
