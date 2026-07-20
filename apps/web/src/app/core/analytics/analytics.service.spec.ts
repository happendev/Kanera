import { describe, expect, it } from "vitest";
import { analyticsRuntimeAllowed, POSTHOG_PRIVACY_CONFIG } from "./analytics.service";

describe("PostHog privacy configuration", () => {
  it("explicitly disables automatic and recording capabilities", () => {
    expect(POSTHOG_PRIVACY_CONFIG).toMatchObject({
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      capture_exceptions: false,
      capture_heatmaps: false,
      capture_performance: false,
      disable_session_recording: true,
      disable_surveys: true,
      disable_external_dependency_loading: true,
      advanced_disable_flags: true,
      ip: false,
      respect_dnt: true,
      mask_all_text: true,
      mask_all_element_attributes: true,
      person_profiles: "identified_only",
      cross_subdomain_cookie: true,
    });
  });

  it("allows initialization only for an enabled hosted production deployment on a non-local host", () => {
    const config = {
      enabled: true as const,
      provider: "posthog" as const,
      projectKey: "phc_public",
      apiHost: "https://eu.i.posthog.com",
    };
    expect(analyticsRuntimeAllowed(null, true, "board.kanera.app", "hosted")).toBe(false);
    expect(analyticsRuntimeAllowed(config, false, "board.kanera.app", "hosted")).toBe(false);
    expect(analyticsRuntimeAllowed(config, true, "localhost", "hosted")).toBe(false);
    // Analytics must never fire outside hosted mode, even with an otherwise valid config.
    expect(analyticsRuntimeAllowed(config, true, "board.kanera.app", "self_hosted")).toBe(false);
    expect(analyticsRuntimeAllowed(config, true, "board.kanera.app", undefined)).toBe(false);
    expect(analyticsRuntimeAllowed(config, true, "board.kanera.app", "hosted")).toBe(true);
  });
});
