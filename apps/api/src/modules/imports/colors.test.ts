import assert from "node:assert/strict";
import { test } from "node:test";
import { trelloColorToToken, trelloCustomFieldTypeToKanera } from "./colors.js";

void test("maps Trello colors to Kanera color tokens", () => {
  assert.equal(trelloColorToToken("green"), "green");
  assert.equal(trelloColorToToken("black_dark"), "gray");
  assert.equal(trelloColorToToken("sky_light"), "sky");
  assert.equal(trelloColorToToken(null), "gray");
  assert.equal(trelloColorToToken("unknown"), "gray");
});

void test("maps Trello custom field types to Kanera custom field types", () => {
  assert.equal(trelloCustomFieldTypeToKanera("text"), "text");
  assert.equal(trelloCustomFieldTypeToKanera("number"), "number");
  assert.equal(trelloCustomFieldTypeToKanera("date"), "date");
  assert.equal(trelloCustomFieldTypeToKanera("checkbox"), "checkbox");
  assert.equal(trelloCustomFieldTypeToKanera("list"), "select");
  assert.equal(trelloCustomFieldTypeToKanera("mystery"), "text");
});
