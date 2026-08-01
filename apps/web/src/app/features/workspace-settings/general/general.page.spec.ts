import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../../../core/api/api.client";
import { WorkspaceSettingsPage } from "../workspace-settings.page";
import { WorkspaceSettingsGeneralPage } from "./general.page";

describe("WorkspaceSettingsGeneralPage", () => {
  const updateCardKeyPrefix = vi.fn();
  const settings = {
    selectedTab: signal("general"),
    workspace: signal({ cardKeyPrefix: "WORK" }),
    boardId: signal<string | undefined>(undefined),
    isStandalone: () => false,
    updateCardKeyPrefix,
  };

  beforeEach(() => {
    updateCardKeyPrefix.mockReset();
    settings.workspace.set({ cardKeyPrefix: "WORK" });
    TestBed.configureTestingModule({
      imports: [WorkspaceSettingsGeneralPage],
      providers: [
        provideZonelessChangeDetection(),
        { provide: WorkspaceSettingsPage, useValue: settings },
        { provide: ApiClient, useValue: { get: vi.fn(), patch: vi.fn() } },
      ],
    });
  });

  it("explains a reserved-prefix conflict instead of showing the HTTP status", async () => {
    updateCardKeyPrefix.mockRejectedValueOnce(new ApiError(409, {
      message: "card key prefix is already reserved",
    }));
    const fixture = TestBed.createComponent(WorkspaceSettingsGeneralPage);
    fixture.componentInstance.cardKeyPrefix.set("TAKEN");

    await fixture.componentInstance.saveCardKeyPrefix();

    expect(updateCardKeyPrefix).toHaveBeenCalledWith("TAKEN");
    expect(fixture.componentInstance.cardKeyPrefixError()).toBe(
      "That prefix is already reserved by another workspace in this organisation. Choose a different prefix.",
    );
    expect(fixture.componentInstance.cardKeyPrefix()).toBe("WORK");
  });
});
