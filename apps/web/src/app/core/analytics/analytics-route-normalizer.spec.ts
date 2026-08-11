import type { ActivatedRouteSnapshot } from "@angular/router";
import { describe, expect, it } from "vitest";
import { pageCategory, routePattern, shouldCapturePageView } from "./analytics-route-normalizer";

describe("analytics route normalization", () => {
  it("uses route templates instead of rendered IDs or query strings", () => {
    const snapshot = {
      pathFromRoot: [
        { routeConfig: { path: "" } },
        { routeConfig: { path: "b/:boardId" } },
      ],
    } as unknown as ActivatedRouteSnapshot;
    expect(routePattern(snapshot)).toBe("/b/:boardId");
    expect(pageCategory(routePattern(snapshot))).toBe("board");
  });

  it("uses configured templates for optional-card matcher routes", () => {
    const snapshot = {
      data: { routePattern: "/b/:boardId", cardRoutePattern: "/b/:boardId/c/:cardId" },
      paramMap: { has: (name: string) => name === "cardId" },
      pathFromRoot: [],
    } as unknown as ActivatedRouteSnapshot;
    expect(routePattern(snapshot)).toBe("/b/:boardId/c/:cardId");
    expect(pageCategory(routePattern(snapshot))).toBe("board");
  });

  it("captures funnel pageviews without turning product navigation into an activity stream", () => {
    expect(shouldCapturePageView("/signup")).toBe(true);
    expect(shouldCapturePageView("/board-invite")).toBe(true);
    expect(shouldCapturePageView("/invite")).toBe(true);
    expect(shouldCapturePageView("/onboarding")).toBe(true);
    expect(shouldCapturePageView("/b/:boardId")).toBe(false);
    expect(shouldCapturePageView("/b/:boardId/c/:cardId")).toBe(false);
    expect(shouldCapturePageView("/my-cards")).toBe(false);
    expect(shouldCapturePageView("/w/:workspaceId/settings/members")).toBe(false);
    expect(shouldCapturePageView("/settings/account-plan")).toBe(false);
  });
});
