import { TestBed } from "@angular/core/testing";
import type { UrlTree } from "@angular/router";
import { Router } from "@angular/router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/api.client";
import { AuthService } from "./auth.service";
import { workspaceGuard } from "./workspace.guard";

describe("workspaceGuard", () => {
  type GuardHome = {
    groups: Array<{ workspace: { kind?: "standard" | "board" }; boards: unknown[] }>;
    guestGroups: Array<{ boards: unknown[] }>;
    pendingBoardInvitations?: unknown[];
  };

  const hydrate = vi.fn(async () => undefined);
  const user = vi.fn(() => ({ hasWorkspace: false }));
  const isOrgAdmin = vi.fn(() => true);
  const get = vi.fn<(_path: string) => Promise<GuardHome>>(() => Promise.resolve({ groups: [], guestGroups: [] }));
  const redirectTree = {} as UrlTree;
  const createUrlTree = vi.fn(() => redirectTree);

  beforeEach(() => {
    vi.clearAllMocks();
    user.mockReturnValue({ hasWorkspace: false });
    isOrgAdmin.mockReturnValue(true);
    get.mockResolvedValue({ groups: [], guestGroups: [] });
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: { hydrate, user, isOrgAdmin } },
        { provide: ApiClient, useValue: { get } },
        { provide: Router, useValue: { createUrlTree } },
      ],
    });
  });

  function runGuard() {
    return TestBed.runInInjectionContext(() => workspaceGuard({} as never, {} as never));
  }

  it("allows an organisation with only a standalone board into the app", async () => {
    get.mockResolvedValue({
      groups: [{ workspace: { kind: "board" }, boards: [{ id: "standalone-board" }] }],
      guestGroups: [],
    });

    await expect(runGuard()).resolves.toBe(true);
    expect(createUrlTree).not.toHaveBeenCalled();
  });

  it("redirects a genuinely empty admin organisation to onboarding", async () => {
    await expect(runGuard()).resolves.toBe(redirectTree);
    expect(createUrlTree).toHaveBeenCalledWith(["/onboarding"]);
  });

  it("allows an admin with a pending board invitation into the app", async () => {
    get.mockResolvedValue({ groups: [], guestGroups: [], pendingBoardInvitations: [{ id: "invite-1" }] });

    await expect(runGuard()).resolves.toBe(true);
    expect(createUrlTree).not.toHaveBeenCalled();
  });

  it("does not load home content when a standard workspace already exists", async () => {
    user.mockReturnValue({ hasWorkspace: true });

    await expect(runGuard()).resolves.toBe(true);
    expect(get).not.toHaveBeenCalled();
  });
});
