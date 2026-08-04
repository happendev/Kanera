import { ApplicationRef, provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { Router } from "@angular/router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../core/api/api.client";
import { AuthService } from "../core/auth/auth.service";
import { UpgradePromptService } from "./upgrade-prompt.service";

describe("UpgradePromptService", () => {
  const isOrgAdmin = signal(false);
  const apiGet = vi.fn();

  beforeEach(() => {
    isOrgAdmin.set(false);
    apiGet.mockReset();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: { get: apiGet } },
        {
          provide: AuthService,
          useValue: {
            entitlements: signal({ tier: "free" }),
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

  it("asks workspace admins to contact their organisation owner without requesting billing", async () => {
    await TestBed.inject(UpgradePromptService).open({ reason: "api" });
    TestBed.inject(ApplicationRef).tick();

    expect(apiGet).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Ask your organisation owner to review Pro and your team's exact price.");
    expect(document.body.textContent).not.toContain("Review Pro and pricing");
    expect(document.body.textContent).toContain("Got it");
  });

  it("describes the real active board count instead of the plan cap", async () => {
    isOrgAdmin.set(true);
    apiGet.mockResolvedValue({ usedSeats: 2, proPricing: { monthlyCents: 500, annualCents: 4_900 } });

    await TestBed.inject(UpgradePromptService).open({ reason: "board", boardCount: 7 });
    TestBed.inject(ApplicationRef).tick();

    expect(document.body.textContent).toContain("Your team already runs 7 active projects");
  });
});
