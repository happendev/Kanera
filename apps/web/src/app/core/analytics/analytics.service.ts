import { Injectable, inject, signal } from "@angular/core";
import { NavigationEnd, Router } from "@angular/router";
import type { PostHog, PostHogConfig } from "posthog-js/dist/module.no-external";
import { filter } from "rxjs";
import { environment } from "../../../environments/environment";
import { clearKnownAnalyticsStorage } from "../consent/cookie-consent.service";
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
  cookie_expiration: 180,
  cross_subdomain_cookie: true,
  sanitize_properties: sanitizeAnalyticsProperties,
} satisfies Partial<PostHogConfig>;

@Injectable({ providedIn: "root" })
export class AnalyticsService {
  private readonly router = inject(Router);
  private instance: PostHog | null = null;
  private runtimeConfig: AnalyticsRuntimeConfig | null = null;
  private policySuppressed = false;
  private consentGranted = false;
  private routesInstalled = false;
  private initializationAttempt = 0;
  private readonly _ready = signal(false);

  readonly ready = this._ready.asReadonly();

  configure(config: AnalyticsRuntimeConfig | null, deploymentMode: "self_hosted" | "hosted" | undefined): boolean {
    if (!this.analyticsAllowed(config, deploymentMode)) {
      this.runtimeConfig = null;
      return false;
    }
    this.runtimeConfig = config;
    if (this.consentGranted) void this.initializeConfigured();
    return true;
  }

  setConsent(granted: boolean): void {
    if (granted === this.consentGranted) {
      // A rejection made on www.kanera.app cannot directly erase board.kanera.app localStorage.
      // Clear it when this origin is next visited, even though the in-memory state already defaults off.
      if (!granted) clearKnownAnalyticsStorage();
      return;
    }
    this.consentGranted = granted;
    if (granted) {
      if (this.instance) {
        if (!this.policySuppressed) {
          try { this.instance.opt_in_capturing(); } catch { /* Non-fatal. */ }
        }
        this._ready.set(true);
      } else if (this.runtimeConfig) {
        void this.initializeConfigured();
      }
      return;
    }

    // Withdrawal must stop in-flight initialisation and remove optional state from this origin and
    // the shared Kanera cookie domain. The consent record itself remains as the necessary choice.
    this.initializationAttempt += 1;
    this._ready.set(false);
    if (this.instance) {
      try { this.instance.reset(true); } catch { /* Cleanup remains best-effort. */ }
      try { this.instance.opt_out_capturing(); } catch { /* Cleanup remains best-effort. */ }
    }
    clearKnownAnalyticsStorage();
  }

  private async initializeConfigured(): Promise<void> {
    const config = this.runtimeConfig;
    if (!config || this.instance || !this.consentGranted) return;
    const attempt = ++this.initializationAttempt;
    // Analytics is optional; a blocked provider chunk must not affect the product.
    const module = await import("posthog-js/dist/module.no-external").catch(() => null);
    if (!module) return;
    if (attempt !== this.initializationAttempt || !this.consentGranted || !this.runtimeConfig) return;
    let initialized: PostHog | undefined;
    try {
      initialized = module.default.init(config.projectKey, {
        ...POSTHOG_PRIVACY_CONFIG,
        api_host: config.apiHost,
        loaded: (instance) => {
          if (this.policySuppressed || !this.consentGranted) instance.opt_out_capturing();
          else instance.opt_in_capturing();
        },
      });
    } catch {
      return;
    }
    if (!initialized || attempt !== this.initializationAttempt || !this.consentGranted) return;
    this.instance = initialized;
    this._ready.set(true);
    this.installRouteTracking();
    // Consent may be granted after Angular's initial navigation. Capture the current non-board
    // route now; board routes wait for their authorised payload so guest organisation grouping is correct.
    let snapshot = this.router.routerState.snapshot.root;
    while (snapshot.firstChild) snapshot = snapshot.firstChild;
    const pattern = routePattern(snapshot);
    if (pattern !== "/b/:boardId" && pattern !== "/b/:boardId/c/:cardId") this.pageCurrentRoute();
  }

  identify(input: AnalyticsUserIdentity): void {
    if (!this.canCapture()) return;
    // Identifiable fields belong only to the durable person profile. The provider-boundary
    // sanitizer permits them inside $identify while continuing to strip them from product events.
    try { this.instance!.identify(input.userId, { name: input.name, email: input.email }); } catch { /* Provider failures are non-fatal. */ }
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

  page(input: AnalyticsPageView, organizationId?: string): void {
    if (!this.canCapture()) return;
    try {
      this.instance!.capture("$pageview", {
        ...input,
        // Override the authenticated user's home org when they are a guest in customer work.
        ...(organizationId ? { $groups: { organization: organizationId } } : {}),
      });
    } catch { /* Non-fatal. */ }
  }

  pageCurrentRoute(organizationId?: string): void {
    if (!this.canCapture()) return;
    let snapshot = this.router.routerState.snapshot.root;
    while (snapshot.firstChild) snapshot = snapshot.firstChild;
    const pattern = routePattern(snapshot);
    this.registerRoute(pattern);
    this.page({
      route_pattern: pattern,
      page_category: pageCategory(pattern),
      is_authenticated: !/^\/(login|signup|forgot-password|reset-password|board-invite)/.test(pattern),
    }, organizationId);
  }

  reset(): void {
    try { this.instance?.reset(); } catch { /* Identity cleanup remains best-effort. */ }
  }

  optIn(): void {
    this.setConsent(true);
  }

  optOut(): void {
    this.setConsent(false);
  }

  setSuppressed(suppressed: boolean): void {
    if (suppressed === this.policySuppressed) return;
    this.policySuppressed = suppressed;
    if (suppressed) {
      this.reset();
      try { this.instance?.opt_out_capturing(); } catch { /* Non-fatal. */ }
    } else {
      if (this.consentGranted) {
        try { this.instance?.opt_in_capturing(); } catch { /* Non-fatal. */ }
      }
      this.reset();
    }
  }

  private canCapture(): boolean {
    return !!this.instance && this.consentGranted && !this.policySuppressed;
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
      this.registerRoute(pattern);
      // Board pages wait for their authorised payload so cross-org guest views use the board owner.
      if (pattern === "/b/:boardId" || pattern === "/b/:boardId/c/:cardId") return;
      this.page({
        route_pattern: pattern,
        page_category: pageCategory(pattern),
        is_authenticated: !/^\/(login|signup|forgot-password|reset-password|board-invite)/.test(pattern),
      });
    });
  }

  private registerRoute(pattern: string): void {
    // PostHog's activity feed reads `$current_url`. Register a route-template URL so every
    // browser event has useful screen context without exposing entity IDs or query strings.
    this.instance!.register({
      route_pattern: pattern,
      $current_url: `${window.location.origin}${pattern}`,
    });
  }
}
