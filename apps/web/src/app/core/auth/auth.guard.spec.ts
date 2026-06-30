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
  let redirectTree: UrlTree;

  beforeEach(() => {
    hydrate = vi.fn(async () => undefined);
    isAuthenticated = vi.fn(() => false);
    redirectTree = {} as UrlTree;
    createUrlTree = vi.fn(() => redirectTree);

    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: { hydrate, isAuthenticated } },
        { provide: Router, useValue: { createUrlTree } },
      ],
    });
  });

  async function runGuard() {
    return TestBed.runInInjectionContext(() => publicAuthGuard({} as never, {} as never));
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
});
