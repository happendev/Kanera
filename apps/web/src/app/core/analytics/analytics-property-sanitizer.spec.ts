import { describe, expect, it } from "vitest";
import { sanitizeAnalyticsProperties } from "./analytics-property-sanitizer";

describe("sanitizeAnalyticsProperties", () => {
  it("keeps only properties explicitly allowed for the event", () => {
    expect(sanitizeAnalyticsProperties({
      route_pattern: "/b/:boardId",
      page_category: "board",
      is_authenticated: true,
      token: "phc_project_token",
      distinct_id: "anonymous-id",
      $device_id: "anonymous-id",
      raw_url_with_query_string: "/b/customer-name?search=secret",
      board_name: "Customer launch",
    }, "$pageview")).toEqual({
      route_pattern: "/b/:boardId",
      page_category: "board",
      is_authenticated: true,
      token: "phc_project_token",
      distinct_id: "anonymous-id",
      $device_id: "anonymous-id",
    });
  });

  it("keeps transport properties but drops caller properties for unknown events", () => {
    expect(sanitizeAnalyticsProperties({
      token: "phc_project_token",
      distinct_id: "anonymous-id",
      email: "person@example.com",
    }, "unknown_event")).toEqual({
      token: "phc_project_token",
      distinct_id: "anonymous-id",
    });
  });

  it("keeps only the approved registration_started contract", () => {
    expect(sanitizeAnalyticsProperties({
      anonymous_id: "anonymous-id",
      source: "google",
      medium: "cpc",
      campaign: "trello-alternative",
      landing_page: "/trello-alternative",
      event_version: 1,
      email: "person@example.com",
      source_surface: "hero",
    }, "registration_started")).toEqual({
      anonymous_id: "anonymous-id",
      source: "google",
      medium: "cpc",
      campaign: "trello-alternative",
      landing_page: "/trello-alternative",
      event_version: 1,
    });
  });

  it("preserves only the technical identifiers needed to merge an anonymous visitor", () => {
    expect(sanitizeAnalyticsProperties({
      $anon_distinct_id: "anonymous-id",
      email: "person@example.com",
      $current_url: "/signup?email=person@example.com",
      $set_once: {
        $initial_utm_source: "google",
        $initial_utm_campaign: "trello_alternative",
        $initial_current_url: "/signup?email=person@example.com",
        email: "person@example.com",
      },
    }, "$identify")).toEqual({
      $anon_distinct_id: "anonymous-id",
      $set_once: {
        $initial_utm_source: "google",
        $initial_utm_campaign: "trello_alternative",
      },
    });
  });
});
