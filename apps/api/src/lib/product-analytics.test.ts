import assert from "node:assert/strict";
import { test } from "node:test";
import "../test/setup.js";
import { env } from "../env.js";
import {
  ANALYTICS_EVENT_VERSION,
  analyticsCardCreationSource,
  analyticsCountBand,
  analyticsDaysSince,
  analyticsPlanCode,
  sanitizeEventProperties,
  seatBand,
  serverAnalyticsEnabled,
} from "./product-analytics.js";

void test("server analytics uses the shared PostHog capture configuration", () => {
  const previous = {
    enabled: env.ANALYTICS_ENABLED,
    provider: env.ANALYTICS_PROVIDER,
    deploymentMode: env.KANERA_DEPLOYMENT_MODE,
    environment: env.KANERA_ENVIRONMENT,
    projectKey: env.POSTHOG_PROJECT_KEY,
    apiHost: env.POSTHOG_API_HOST,
  };
  try {
    env.ANALYTICS_ENABLED = true;
    env.ANALYTICS_PROVIDER = "posthog";
    env.KANERA_DEPLOYMENT_MODE = "hosted";
    env.KANERA_ENVIRONMENT = "staging";
    env.POSTHOG_PROJECT_KEY = "phc_shared_capture_token";
    env.POSTHOG_API_HOST = "https://eu.i.posthog.com";
    assert.equal(serverAnalyticsEnabled(), true);

    env.POSTHOG_PROJECT_KEY = undefined;
    assert.equal(serverAnalyticsEnabled(), false);
  } finally {
    env.ANALYTICS_ENABLED = previous.enabled;
    env.ANALYTICS_PROVIDER = previous.provider;
    env.KANERA_DEPLOYMENT_MODE = previous.deploymentMode;
    env.KANERA_ENVIRONMENT = previous.environment;
    env.POSTHOG_PROJECT_KEY = previous.projectKey;
    env.POSTHOG_API_HOST = previous.apiHost;
  }
});

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

void test("card creation analytics keeps attribution but rejects card content", () => {
  const properties = sanitizeEventProperties("card_created", {
    user_id: "user-id",
    workspace_id: "workspace-id",
    creation_source: "web",
    event_version: ANALYTICS_EVENT_VERSION,
    card_id: "card-id",
    card_title: "Private customer work",
    board_name: "Private customer board",
  } as never);
  assert.deepEqual(properties, {
    user_id: "user-id",
    workspace_id: "workspace-id",
    creation_source: "web",
    event_version: ANALYTICS_EVENT_VERSION,
  });
});

void test("card creation analytics distinguishes web, public API, and official MCP traffic", () => {
  assert.equal(analyticsCardCreationSource("user", undefined), "web");
  assert.equal(analyticsCardCreationSource("apiKey", undefined), "public_api");
  assert.equal(analyticsCardCreationSource("apiKey", "mcp"), "mcp");
  // A provenance header never overrides an interactive or support-session identity.
  assert.equal(analyticsCardCreationSource("user", "mcp"), "web");
  assert.equal(analyticsCardCreationSource("support", "mcp"), "web");
});

void test("analytics categories are stable at their boundaries", () => {
  assert.equal(analyticsPlanCode("trialing"), "pro_trial");
  assert.equal(analyticsPlanCode("active"), "pro");
  assert.equal(analyticsPlanCode("none"), "free");
  assert.deepEqual([0, 1, 2, 3, 4, 10, 11].map(analyticsCountBand), ["0", "1", "2_3", "2_3", "4_10", "4_10", "11_plus"]);
  assert.deepEqual([0, 1, 2, 4, 5, 10, 11].map(seatBand), ["1", "1", "2_4", "2_4", "5_10", "5_10", "over_10"]);
  assert.equal(analyticsDaysSince(new Date("2026-07-01T12:00:00Z"), new Date("2026-07-03T11:59:59Z")), 1);
});
