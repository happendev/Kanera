import type { ActivatedRouteSnapshot } from "@angular/router";
import { describe, expect, it } from "vitest";
import { pageCategory, routePattern } from "./analytics-route-normalizer";

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
});
