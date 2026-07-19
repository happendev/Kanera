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
});
