import assert from "node:assert/strict";
import { test } from "node:test";
import "../test/setup.js";
import {
  ANALYTICS_EVENT_VERSION,
  analyticsCountBand,
  analyticsDaysSince,
  analyticsPlanCode,
  sanitizeEventProperties,
  seatBand,
} from "./product-analytics.js";

void test("server analytics removes properties outside the event allow-list", () => {
  const properties = sanitizeEventProperties("board_created", {
    user_id: "user-id",
    workspace_id: "workspace-id",
    board_count_band: "2_3",
    event_version: ANALYTICS_EVENT_VERSION,
    board_name: "Private customer board",
    description: "Private content",
  } as never);
  assert.deepEqual(properties, {
    user_id: "user-id",
    workspace_id: "workspace-id",
    board_count_band: "2_3",
    event_version: ANALYTICS_EVENT_VERSION,
  });
});

void test("analytics categories are stable at their boundaries", () => {
  assert.equal(analyticsPlanCode("trialing"), "pro_trial");
  assert.equal(analyticsPlanCode("active"), "pro");
  assert.equal(analyticsPlanCode("none"), "free");
  assert.deepEqual([0, 1, 2, 3, 4, 10, 11].map(analyticsCountBand), ["0", "1", "2_3", "2_3", "4_10", "4_10", "11_plus"]);
  assert.deepEqual([0, 1, 2, 4, 5, 10, 11].map(seatBand), ["1", "1", "2_4", "2_4", "5_10", "5_10", "over_10"]);
  assert.equal(analyticsDaysSince(new Date("2026-07-01T12:00:00Z"), new Date("2026-07-03T11:59:59Z")), 1);
});
