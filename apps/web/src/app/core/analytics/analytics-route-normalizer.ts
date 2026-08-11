import type { ActivatedRouteSnapshot } from "@angular/router";
import type { AnalyticsPageView } from "./analytics.types";

export function routePattern(snapshot: ActivatedRouteSnapshot): string {
  const routeData = snapshot.data as Record<string, unknown> | undefined;
  const configured = routeData?.["routePattern"];
  const configuredCard = routeData?.["cardRoutePattern"];
  if (typeof configured === "string") {
    return snapshot.paramMap.has("cardId") && typeof configuredCard === "string" ? configuredCard : configured;
  }
  const segments = snapshot.pathFromRoot.flatMap((route) => route.routeConfig?.path?.split("/").filter(Boolean) ?? []);
  return segments.length > 0 ? `/${segments.join("/")}` : "/";
}

export function pageCategory(pattern: string): AnalyticsPageView["page_category"] {
  if (/^\/(login|signup|forgot-password|reset-password|board-invite|invite)/.test(pattern)) return "authentication";
  if (pattern.startsWith("/onboarding")) return "onboarding";
  if (pattern.includes("/settings/members") || pattern.includes("/settings/guests")) return "team";
  if (pattern === "/settings" || pattern.includes("billing")) return "billing";
  if (pattern.startsWith("/b/:boardId")) return "board";
  if (pattern.includes("settings")) return "settings";
  return "workspace";
}

/**
 * Pageviews are acquisition/onboarding steps, not a second audit trail of customer work. Upgrade
 * friction is captured by explicit pricing, limit, modal, checkout, and billing lifecycle events.
 */
export function shouldCapturePageView(pattern: string): boolean {
  return pageCategory(pattern) === "authentication" || pattern.startsWith("/onboarding");
}
