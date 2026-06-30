import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { AnalyzeKaneraBoardImportResponse, KaneraBoardImportManifest } from "@kanera/shared/dto";
import type { WorkspaceMember } from "@kanera/shared/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../core/api/api.client";
import { TrelloImportPage } from "./trello-import.page";

type MemberRow = WorkspaceMember & { email: string; displayName: string; avatarUrl: string | null };

function workspaceMember(overrides: Partial<MemberRow> = {}): MemberRow {
  return {
    workspaceId: "workspace-1",
    userId: "target-user",
    role: "owner",
    addedAt: new Date("2026-06-17T00:00:00.000Z"),
    displayName: "Dylan van der Merwe",
    email: "dylan@happen.software",
    avatarUrl: null,
    ...overrides,
  };
}

function kaneraManifest(): KaneraBoardImportManifest {
  return {
    source: "kanera",
    board: { name: "GENERAL", desc: null, visibility: "workspace", icon: null, iconColor: null },
    lists: [],
    labels: [],
    customFields: [],
    members: [{
      id: "source-user",
      fullName: "Dylan van der Merwe",
      username: null,
      source: "workspace",
      boardRole: "editor",
    }],
    counts: { cards: 0, checklists: 0, comments: 0, linkAttachments: 0, uploadedAttachments: 0 },
  };
}

describe("TrelloImportPage", () => {
  let api: { request: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    api = { request: vi.fn(), get: vi.fn() };
    TestBed.configureTestingModule({
      imports: [TrelloImportPage],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: api },
      ],
    });
  });

  it("loads workspace members before auto-mapping older Kanera exports", async () => {
    api.request.mockResolvedValueOnce({ importId: "import-1", manifest: kaneraManifest() } satisfies AnalyzeKaneraBoardImportResponse);
    api.get.mockResolvedValueOnce([workspaceMember()]);
    const fixture = TestBed.createComponent(TrelloImportPage);
    fixture.componentRef.setInput("source", "kanera");
    fixture.componentRef.setInput("workspaceId", "workspace-1");
    fixture.componentRef.setInput("members", []);
    fixture.detectChanges();
    fixture.componentInstance.selectedFile.set(new File(["{}"], "GENERAL.json", { type: "application/json" }));

    await fixture.componentInstance.analyze(new Event("submit"));

    expect(api.get).toHaveBeenCalledWith("/workspaces/workspace-1/members");
    expect(fixture.componentInstance.memberMappings()).toEqual({ "source-user": "target-user" });
  });

  it("reflects the auto-mapped member in the rendered select, not just the signal", async () => {
    api.request.mockResolvedValueOnce({ importId: "import-1", manifest: kaneraManifest() } satisfies AnalyzeKaneraBoardImportResponse);
    const fixture = TestBed.createComponent(TrelloImportPage);
    fixture.componentRef.setInput("source", "kanera");
    fixture.componentRef.setInput("workspaceId", "workspace-1");
    // Mirror the real app, where the parent passes workspace members as an input so the
    // dropdown options render. Matching then populates memberMappings from those members.
    fixture.componentRef.setInput("members", [workspaceMember()]);
    fixture.detectChanges();
    fixture.componentInstance.selectedFile.set(new File(["{}"], "GENERAL.json", { type: "application/json" }));

    await fixture.componentInstance.analyze(new Event("submit"));
    fixture.componentInstance.step.set("members");
    fixture.detectChanges();

    // Guards the binding regression: the option must carry `selected` so the native
    // select shows the auto-mapped member instead of falling back to "Unassigned".
    const select = (fixture.nativeElement as HTMLElement).querySelector(".member-row select") as HTMLSelectElement | null;
    expect(select?.value).toBe("target-user");
  });
});
