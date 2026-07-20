import { Injectable, inject } from "@angular/core";
import { NavigationEnd, Router } from "@angular/router";
import posthog, { type PostHog, type PostHogConfig } from "posthog-js/dist/module.no-external";
import { filter } from "rxjs";
import { environment } from "../../../environments/environment";
import type { AnalyticsEventMap, AnalyticsEventName } from "./analytics-events";
import { pageCategory, routePattern } from "./analytics-route-normalizer";
import { sanitizeAnalyticsProperties } from "./analytics-property-sanitizer";
import type { AnalyticsOrganizationIdentity, AnalyticsPageView, AnalyticsRuntimeConfig, AnalyticsUserIdentity } from "./analytics.types";

const DEVELOPMENT_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function analyticsRuntimeAllowed(
  config: AnalyticsRuntimeConfig | null,
  production: boolean,
  hostname: string,
  deploymentMode: "self_hosted" | "hosted" | undefined,
): config is AnalyticsRuntimeConfig {
  return !!config
    && config.enabled
    && config.provider === "posthog"
    // Analytics must never fire outside the hosted product. This is defence-in-depth: the API only
    // returns a runtime config in hosted mode, and this guard refuses to initialise even if one leaks.
    && deploymentMode === "hosted"
    && production
    && !DEVELOPMENT_HOSTNAMES.has(hostname.toLowerCase());
}

export const POSTHOG_PRIVACY_CONFIG = {
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
  property_denylist: ["name", "email", "title", "description", "comment", "note_content", "card_content", "list_name", "board_name", "workspace_name", "attachment_name", "attachment_url", "search_query", "authentication_token", "invitation_token", "raw_route", "raw_url_with_query_string"],
  person_profiles: "identified_only",
  persistence: "localStorage+cookie",
  cross_subdomain_cookie: true,
  sanitize_properties: sanitizeAnalyticsProperties,
} satisfies Partial<PostHogConfig>;

@Injectable({ providedIn: "root" })
export class AnalyticsService {
  private readonly router = inject(Router);
  private instance: PostHog | null = null;
  private policySuppressed = false;
  private userOptedOut = false;
  private routesInstalled = false;

  initialize(config: AnalyticsRuntimeConfig | null, deploymentMode: "self_hosted" | "hosted" | undefined): void {
    if (this.instance || !this.analyticsAllowed(config, deploymentMode)) return;
    this.instance = posthog.init(config!.projectKey, {
      ...POSTHOG_PRIVACY_CONFIG,
      api_host: config!.apiHost,
      loaded: (instance) => {
        // Keep a persisted consent choice separate from temporary support/internal suppression.
        this.userOptedOut = instance.has_opted_out_capturing();
        if (this.policySuppressed || this.userOptedOut) instance.opt_out_capturing();
      },
    });
    this.installRouteTracking();
  }

  identify(input: AnalyticsUserIdentity): void {
    if (!this.canCapture()) return;
    try { this.instance!.identify(input.userId); } catch { /* Provider failures are non-fatal. */ }
  }

  anonymousId(): string | null {
    if (!this.canCapture()) return null;
    try { return this.instance!.get_distinct_id(); } catch { return null; }
  }

  setOrganization(input: AnalyticsOrganizationIdentity): void {
    if (!this.canCapture()) return;
    try { this.instance!.group("organization", input.organizationId, input.properties); } catch { /* Non-fatal. */ }
  }

  track<TEvent extends AnalyticsEventName>(event: TEvent, properties: AnalyticsEventMap[TEvent]): void {
    if (!this.canCapture()) return;
    try { this.instance!.capture(event, properties); } catch { /* Non-fatal. */ }
  }

  page(input: AnalyticsPageView): void {
    if (!this.canCapture()) return;
    try { this.instance!.capture("$pageview", input); } catch { /* Non-fatal. */ }
  }

  reset(): void {
    try { this.instance?.reset(); } catch { /* Identity cleanup remains best-effort. */ }
  }

  optIn(): void {
    this.userOptedOut = false;
    if (this.policySuppressed) return;
    try { this.instance?.opt_in_capturing(); } catch { /* Non-fatal. */ }
  }

  optOut(): void {
    this.userOptedOut = true;
    try { this.instance?.opt_out_capturing(); } catch { /* Non-fatal. */ }
  }

  setSuppressed(suppressed: boolean): void {
    if (suppressed === this.policySuppressed) return;
    this.policySuppressed = suppressed;
    if (suppressed) {
      this.reset();
      try { this.instance?.opt_out_capturing(); } catch { /* Non-fatal. */ }
    } else {
      if (!this.userOptedOut) {
        try { this.instance?.opt_in_capturing(); } catch { /* Non-fatal. */ }
      }
      this.reset();
    }
  }

  private canCapture(): boolean {
    return !!this.instance && !this.policySuppressed && !this.userOptedOut;
  }

  private analyticsAllowed(config: AnalyticsRuntimeConfig | null, deploymentMode: "self_hosted" | "hosted" | undefined): boolean {
    return typeof window !== "undefined"
      && analyticsRuntimeAllowed(config, environment.production, window.location.hostname, deploymentMode);
  }

  private installRouteTracking(): void {
    if (this.routesInstalled) return;
    this.routesInstalled = true;
    this.router.events.pipe(filter((event): event is NavigationEnd => event instanceof NavigationEnd)).subscribe(() => {
      let snapshot = this.router.routerState.snapshot.root;
      while (snapshot.firstChild) snapshot = snapshot.firstChild;
      const pattern = routePattern(snapshot);
      // PostHog's activity feed reads `$current_url`. Register a route-template URL so every
      // browser event has useful screen context without exposing entity IDs or query strings.
      this.instance!.register({
        route_pattern: pattern,
        $current_url: `${window.location.origin}${pattern}`,
      });
      this.page({
        route_pattern: pattern,
        page_category: pageCategory(pattern),
        is_authenticated: !/^\/(login|signup|forgot-password|reset-password|board-invite)/.test(pattern),
      });
    });
  }
}
