import type { Route, UrlSegment } from "@angular/router";
import { describe, expect, it } from "vitest";
import { routes } from "./app.routes";

function segment(path: string): UrlSegment {
  return { path, parameters: {} } as UrlSegment;
}

function matcherRoute(routePattern: string): Route {
  const shell = routes.find((route) => route.path === "");
  const route = shell?.children?.find((candidate) => candidate.data?.["routePattern"] === routePattern);
  if (!route?.matcher) throw new Error(`missing matcher route ${routePattern}`);
  return route;
}

describe("popped-out scratchpad route", () => {
  it("sits outside the shell so the tab is nothing but the notepad", () => {
    const shell = routes.find((route) => route.path === "");
    const scratchpad = routes.find((route) => route.path === "scratchpad");

    expect(scratchpad).toBeDefined();
    // Ahead of the shell's empty path and not one of its children: matching order is what stops
    // /scratchpad resolving as a shell page, with a sidebar and a second scratchpad trigger on it.
    expect(routes.indexOf(scratchpad!)).toBeLessThan(routes.indexOf(shell!));
    expect(shell?.children?.some((child) => child.path === "scratchpad")).toBe(false);
    // Auth only. A scratchpad is private to the user and has no workspace to resolve, so the workspace
    // guard would only redirect this tab into onboarding.
    expect(scratchpad?.canActivate).toHaveLength(1);
  });
});

describe("optional card routes", () => {
  it("uses one board route configuration for the board and its card drawer", () => {
    const route = matcherRoute("/b/:boardId");
    const board = route.matcher!([segment("b"), segment("board-1")], {} as never, route);
    const card = route.matcher!([segment("b"), segment("board-1"), segment("c"), segment("card-1")], {} as never, route);

    expect(board?.posParams?.["boardId"]?.path).toBe("board-1");
    expect(board?.posParams?.["cardId"]).toBeUndefined();
    expect(card?.posParams?.["boardId"]?.path).toBe("board-1");
    expect(card?.posParams?.["cardId"]?.path).toBe("card-1");
  });

  it("uses one Global Work route configuration for collection and card paths", () => {
    const route = matcherRoute("/my-cards");
    const collection = route.matcher!([segment("my-cards")], {} as never, route);
    const card = route.matcher!([segment("my-cards"), segment("c"), segment("card-1")], {} as never, route);

    expect(collection?.posParams?.["cardId"]).toBeUndefined();
    expect(card?.posParams?.["cardId"]?.path).toBe("card-1");
  });
});
