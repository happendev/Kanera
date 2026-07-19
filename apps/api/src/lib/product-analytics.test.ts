import assert from "node:assert/strict";
import { test } from "node:test";
import "../test/setup.js";
import { sanitizeEventProperties } from "./product-analytics.js";

void test("server analytics removes properties outside the event allow-list", () => {
  const properties = sanitizeEventProperties("board_created", {
    creation_source: "admin",
    is_first_board: true,
    template_type: "blank",
    board_name: "Private customer board",
    description: "Private content",
  } as never);
  assert.deepEqual(properties, {
    creation_source: "admin",
    is_first_board: true,
    template_type: "blank",
  });
});
