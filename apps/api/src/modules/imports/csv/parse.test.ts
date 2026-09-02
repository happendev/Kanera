import assert from "node:assert/strict";
import { test } from "node:test";
import { detectHeaderRow, parseCsv } from "./parse.js";

void test("parseCsv sniffs common delimiters and preserves duplicate headers", () => {
  for (const delimiter of [";", "\t", "|"]) {
    const parsed = parseCsv(Buffer.from(`Title${delimiter}Labels${delimiter}Labels\nOne${delimiter}a${delimiter}b`));
    assert.equal(parsed.delimiter, delimiter);
    assert.deepEqual(parsed.rows[0], ["Title", "Labels", "Labels"]);
  }
});

void test("parseCsv keeps quoted newlines, pads ragged rows, and drops blank rows", () => {
  const parsed = parseCsv(Buffer.from('Title,Description\nOne,"first\nsecond"\nTwo\n,\n'));
  assert.deepEqual(parsed.rows, [["Title", "Description"], ["One", "first\nsecond"], ["Two", ""]]);
  assert.equal(parsed.raggedRows, 1);
});

void test("detectHeaderRow recognizes descriptive headers", () => {
  assert.equal(detectHeaderRow([["Title", "Due date"], ["One", "2026-01-01"]]), true);
  assert.equal(detectHeaderRow([["1", "true"], ["2", "false"]]), false);
  assert.equal(detectHeaderRow([["Title", "Labels", "Labels", "Done"], ["Ship", "a", "b", "yes"]]), true);
});

void test("parseCsv enforces the row cap", () => {
  assert.throws(
    () => parseCsv(Buffer.from(Array.from({ length: 20_001 }, (_, index) => `Card ${index}`).join("\n"))),
    /20,000 row limit/,
  );
});
