import assert from "node:assert/strict";
import { test } from "node:test";
import "../test/setup.js";
import { env } from "../env.js";
import {
  ANALYTICS_EVENT_VERSION,
  acquisitionEventProperties,
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

void test("subscription payment analytics keeps revenue dimensions but rejects Stripe identifiers", () => {
  const properties = sanitizeEventProperties("subscription_payment_succeeded", {
    workspace_id: "workspace-id",
    plan_code: "pro",
    billing_period: "monthly",
    seat_band: "2_4",
    revenue: 2_900,
    currency: "EUR",
    billing_reason: "subscription_cycle",
    event_version: ANALYTICS_EVENT_VERSION,
    invoice_id: "in_private",
    customer_id: "cus_private",
    payment_method: "pm_private",
  } as never);
  assert.deepEqual(properties, {
    workspace_id: "workspace-id",
    plan_code: "pro",
    billing_period: "monthly",
    seat_band: "2_4",
    revenue: 2_900,
    currency: "EUR",
    billing_reason: "subscription_cycle",
    event_version: ANALYTICS_EVENT_VERSION,
  });
});

void test("commercial funnel analytics keeps approved context without provider identifiers", () => {
  const properties = sanitizeEventProperties("checkout_abandoned", {
    workspace_id: "organization-id",
    plan_code: "pro",
    billing_period: "annual",
    seat_band: "2_4",
    upgrade_source: "account_plan",
    event_version: ANALYTICS_EVENT_VERSION,
    checkout_session_id: "cs_private",
    customer_id: "cus_private",
  } as never);
  assert.deepEqual(properties, {
    workspace_id: "organization-id",
    plan_code: "pro",
    billing_period: "annual",
    seat_band: "2_4",
    upgrade_source: "account_plan",
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

// Browser E2E cannot inspect private server payloads before ingestion. Protect this boundary
// against leaking click identifiers while retaining the approved campaign dimensions.
void test("durable acquisition sends only campaign dimensions to PostHog", () => {
  assert.deepEqual(acquisitionEventProperties({
    source: "google", medium: "cpc", campaign: "launch", content: "video-a", term: "kanban",
    landing_page: "/pricing", gclid: "private-click", fbclid: "private-meta-click",
    captured_at: "2026-10-26T10:00:00.000Z", consented_at: "2026-10-26T10:00:00.000Z", consent_version: 1,
  }), {
    acquisition_source: "google", acquisition_medium: "cpc", acquisition_campaign: "launch",
    acquisition_content: "video-a", acquisition_term: "kanban", acquisition_landing_page: "/pricing",
    utm_source: "google", utm_medium: "cpc", utm_campaign: "launch", utm_content: "video-a", utm_term: "kanban",
  });
  assert.deepEqual(acquisitionEventProperties(null), {});
});
