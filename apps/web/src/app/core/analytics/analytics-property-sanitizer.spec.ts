import { describe, expect, it } from "vitest";
import { sanitizeAnalyticsProperties } from "./analytics-property-sanitizer";

describe("sanitizeAnalyticsProperties", () => {
  it("keeps only properties explicitly allowed for the event", () => {
    expect(sanitizeAnalyticsProperties({
      route_pattern: "/b/:boardId",
      page_category: "board",
      is_authenticated: true,
      $groups: { organization: "board-owner-org-id" },
      token: "phc_project_token",
      distinct_id: "anonymous-id",
      $device_id: "anonymous-id",
      $current_url: "https://board.kanera.app/b/customer-board-id?search=secret",
      raw_url_with_query_string: "/b/customer-name?search=secret",
      board_name: "Customer launch",
    }, "$pageview")).toEqual({
      route_pattern: "/b/:boardId",
      page_category: "board",
      is_authenticated: true,
      $groups: { organization: "board-owner-org-id" },
      token: "phc_project_token",
      distinct_id: "anonymous-id",
      $device_id: "anonymous-id",
      $current_url: "https://board.kanera.app/b/:boardId",
    });
  });

  it("uses a normalized route-template URL for the activity feed", () => {
    expect(sanitizeAnalyticsProperties({
      route_pattern: "/b/:boardId",
      $current_url: "https://board.kanera.app/b/private-board-id?search=secret#card",
      token: "phc_project_token",
      distinct_id: "anonymous-id",
    }, "checkout_started")).toEqual({
      token: "phc_project_token",
      distinct_id: "anonymous-id",
      $current_url: "https://board.kanera.app/b/:boardId",
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

  it("allows identifiable fields only on the person profile while preserving attribution", () => {
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
      $set: {
        name: "Ada Lovelace",
        email: "person@example.com",
        board_name: "Private board",
      },
    }, "$identify")).toEqual({
      $anon_distinct_id: "anonymous-id",
      $set_once: {
        $initial_utm_source: "google",
        $initial_utm_campaign: "trello_alternative",
        email: "person@example.com",
      },
      $set: {
        name: "Ada Lovelace",
        email: "person@example.com",
      },
    });
  });

  it("allows readable account metadata only on organization group profiles", () => {
    expect(sanitizeAnalyticsProperties({
      token: "phc_project_token",
      distinct_id: "user-id",
      $group_type: "organization",
      $group_key: "organization-id",
      $group_set: {
        name: "Acme Ltd",
        owner_name: "Ada Lovelace",
        owner_user_id: "owner-id",
        deployment_mode: "cloud",
        owner_email: "owner@example.com",
        board_name: "Private board",
      },
    }, "$groupidentify")).toEqual({
      token: "phc_project_token",
      distinct_id: "user-id",
      $group_type: "organization",
      $group_key: "organization-id",
      $group_set: {
        name: "Acme Ltd",
        owner_name: "Ada Lovelace",
        owner_email: "owner@example.com",
        owner_user_id: "owner-id",
        deployment_mode: "cloud",
      },
    });
  });
});
