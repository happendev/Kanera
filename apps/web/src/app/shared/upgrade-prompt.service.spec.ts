import { ApplicationRef, provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { Router } from "@angular/router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../core/api/api.client";
import { AnalyticsService } from "../core/analytics/analytics.service";
import { AuthService } from "../core/auth/auth.service";
import { UpgradePromptService } from "./upgrade-prompt.service";

describe("UpgradePromptService", () => {
  const isOrgAdmin = signal(false);
  const apiGet = vi.fn();
  const analyticsTrack = vi.fn();

  beforeEach(() => {
    isOrgAdmin.set(false);
    apiGet.mockReset();
    apiGet.mockResolvedValue({ memberCount: 2, activeMemberCount: 2, boardCount: 1 });
    analyticsTrack.mockReset();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: { get: apiGet } },
        { provide: AnalyticsService, useValue: { track: analyticsTrack } },
        {
          provide: AuthService,
          useValue: {
            entitlements: signal({
              tier: "free",
              trialEndsAt: null,
              maxBoards: 3,
              maxOrgMembers: 4,
              maxEnabledAutomations: 3,
              maxAutomationExecutionsPerMonth: 100,
            }),
            isOrgAdmin: isOrgAdmin.asReadonly(),
          },
        },
        { provide: Router, useValue: { navigate: vi.fn() } },
      ],
    });
  });

  afterEach(() => {
    document.querySelector<HTMLButtonElement>('k-upgrade-prompt-dialog button[aria-label="Close"]')?.click();
    document.querySelectorAll("k-upgrade-prompt-dialog").forEach((element) => element.remove());
    TestBed.resetTestingModule();
  });

  it("asks workspace admins to contact their owner while attaching content-free limit totals", async () => {
    await TestBed.inject(UpgradePromptService).open({ reason: "api", source: "workspace_settings" });
    TestBed.inject(ApplicationRef).tick();

    expect(apiGet).toHaveBeenCalledWith("/billing/analytics-context");
    expect(document.body.textContent).toContain("Ask your organisation owner to review Pro and your team's exact price.");
    expect(document.body.textContent).not.toContain("Review Pro and pricing");
    expect(document.body.textContent).toContain("Got it");
    expect(analyticsTrack).toHaveBeenCalledWith("plan_limit_reached", {
      limit_type: "api",
      current_usage: 0,
      plan_limit: 0,
      member_count: 2,
      active_member_count: 2,
      board_count: 1,
      trial_days_remaining: 0,
      upgrade_source: "workspace_settings",
    });
  });

  it("describes the real active board count instead of the plan cap", async () => {
    isOrgAdmin.set(true);
    apiGet.mockResolvedValue({
      usedSeats: 2,
      proPricing: { monthlyCents: 500, annualCents: 4_900 },
      analyticsContext: { memberCount: 4, activeMemberCount: 3, boardCount: 7 },
    });

    await TestBed.inject(UpgradePromptService).open({ reason: "board", source: "home", boardCount: 7 });
    TestBed.inject(ApplicationRef).tick();

    expect(document.body.textContent).toContain("Your team already runs 7 active projects");
    document.querySelector<HTMLButtonElement>('k-upgrade-prompt-dialog button[aria-label="Close"]')?.click();
    expect(analyticsTrack).toHaveBeenCalledWith("upgrade_modal_dismissed", expect.objectContaining({
      premium_feature: "boards",
      member_count: 4,
      active_member_count: 3,
      board_count: 7,
      upgrade_source: "home",
    }));
  });
});
