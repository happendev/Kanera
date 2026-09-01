import { TestBed } from "@angular/core/testing";
import type { UrlTree } from "@angular/router";
import { Router } from "@angular/router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "./auth.service";
import { publicAuthGuard } from "./auth.guard";

describe("publicAuthGuard", () => {
  let hydrate: ReturnType<typeof vi.fn>;
  let isAuthenticated: ReturnType<typeof vi.fn>;
  let createUrlTree: ReturnType<typeof vi.fn>;
  let parseUrl: ReturnType<typeof vi.fn>;
  let redirectTree: UrlTree;

  beforeEach(() => {
    hydrate = vi.fn(async () => undefined);
    isAuthenticated = vi.fn(() => false);
    redirectTree = {} as UrlTree;
    createUrlTree = vi.fn(() => redirectTree);
    parseUrl = vi.fn(() => redirectTree);

    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: { hydrate, isAuthenticated } },
        { provide: Router, useValue: { createUrlTree, parseUrl } },
      ],
    });
  });

  async function runGuard(query: Record<string, string | null> = {}) {
    const route = { queryParamMap: { get: (key: string) => query[key] ?? null } };
    return TestBed.runInInjectionContext(() => publicAuthGuard(route as never, {} as never));
  }

  it("allows unauthenticated users through", async () => {
    await expect(runGuard()).resolves.toBe(true);

    expect(createUrlTree).not.toHaveBeenCalled();
  });

  it("redirects authenticated users to the logged-in app", async () => {
    isAuthenticated.mockReturnValue(true);

    await expect(runGuard()).resolves.toBe(redirectTree);

    expect(createUrlTree).toHaveBeenCalledWith(["/"]);
  });

  it("hydrates before checking whether the user is authenticated", async () => {
    const calls: string[] = [];
    hydrate.mockImplementation(async () => {
      calls.push("hydrate");
    });
    isAuthenticated.mockImplementation(() => {
      calls.push("isAuthenticated");
      return false;
    });

    await runGuard();

    expect(calls).toEqual(["hydrate", "isAuthenticated"]);
  });

  it("preserves a board invitation token for authenticated users", async () => {
    isAuthenticated.mockReturnValue(true);

    await expect(runGuard({ boardInviteToken: "board-token" })).resolves.toBe(redirectTree);

    expect(createUrlTree).toHaveBeenCalledWith(["/board-invite"], { queryParams: { token: "board-token" } });
  });

  it("uses only safe local return URLs", async () => {
    isAuthenticated.mockReturnValue(true);

    await runGuard({ returnUrl: "/board-invite?token=abc" });
    expect(parseUrl).toHaveBeenCalledWith("/board-invite?token=abc");

    createUrlTree.mockClear();
    parseUrl.mockClear();
    await runGuard({ returnUrl: "//evil.example/path" });
    expect(parseUrl).not.toHaveBeenCalled();
    expect(createUrlTree).toHaveBeenCalledWith(["/"]);
  });
});
