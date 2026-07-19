import type { ActivatedRouteSnapshot } from "@angular/router";
import type { AnalyticsPageView } from "./analytics.types";

export function routePattern(snapshot: ActivatedRouteSnapshot): string {
  const segments = snapshot.pathFromRoot.flatMap((route) => route.routeConfig?.path?.split("/").filter(Boolean) ?? []);
  return segments.length > 0 ? `/${segments.join("/")}` : "/";
}

export function pageCategory(pattern: string): AnalyticsPageView["page_category"] {
  if (/^\/(login|signup|forgot-password|reset-password|board-invite)/.test(pattern)) return "authentication";
  if (pattern.startsWith("/onboarding")) return "onboarding";
  if (pattern.includes("/settings/members") || pattern.includes("/settings/guests")) return "team";
  if (pattern === "/settings" || pattern.includes("billing")) return "billing";
  if (pattern.startsWith("/b/:boardId")) return "board";
  if (pattern.includes("settings")) return "settings";
  return "workspace";
}
