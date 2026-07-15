import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { provideRouter } from "@angular/router";
import type { AnalyzeImportResponse, AnalyzeKaneraBoardImportResponse, CommitImportBody, ImportResultSummary, KaneraBoardImportManifest, TrelloImportManifest } from "@kanera/shared/dto";
import type { WorkspaceMember } from "@kanera/shared/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../core/api/api.client";
import { ImportNavigationGuardService } from "./import-navigation-guard.service";
import { TrelloImportPage } from "./trello-import.page";

type MemberRow = WorkspaceMember & { email: string; displayName: string; avatarUrl: string | null };

function workspaceMember(overrides: Partial<MemberRow> = {}): MemberRow {
  return {
    workspaceId: "workspace-1",
    userId: "target-user",
    role: "admin",
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
    board: { name: "GENERAL", desc: null, icon: null, iconColor: null },
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

function trelloManifest(): TrelloImportManifest {
  return {
    board: { name: "Launch", desc: null },
    lists: [],
    labels: [],
    customFields: [],
    members: [],
    counts: { cards: 1, checklists: 0, comments: 0, linkAttachments: 0, uploadedAttachments: 1 },
  };
}

function importResult(): ImportResultSummary {
  return {
    createdBoardId: "00000000-0000-4000-8000-000000000001",
    lists: { created: 0, reused: 0, skipped: 0 },
    labels: { created: 0, reused: 0, skipped: 0 },
    customFields: { created: 0, reused: 0, skipped: 0 },
    cards: { created: 1, archived: 0 },
    checklists: 0,
    checklistItems: 0,
    comments: 0,
    attachments: { imported: 1, skipped: 0 },
    warnings: [],
  };
}

describe("TrelloImportPage", () => {
  let api: { request: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
  let importNavigationGuard: { setImportRunning: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    api = { request: vi.fn(), get: vi.fn() };
    importNavigationGuard = { setImportRunning: vi.fn() };
    TestBed.configureTestingModule({
      imports: [TrelloImportPage],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: ApiClient, useValue: api },
        { provide: ImportNavigationGuardService, useValue: importNavigationGuard },
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

  it("loads Trello auth config when uploaded attachments are present", async () => {
    api.request.mockResolvedValueOnce({ importId: "import-1", manifest: trelloManifest() } satisfies AnalyzeImportResponse);
    api.get.mockResolvedValueOnce({ enabled: true, apiKey: "trello-key" });
    const fixture = TestBed.createComponent(TrelloImportPage);
    fixture.componentRef.setInput("source", "trello");
    fixture.componentRef.setInput("workspaceId", "workspace-1");
    fixture.detectChanges();
    fixture.componentInstance.selectedFile.set(new File(["{}"], "trello.json", { type: "application/json" }));

    await fixture.componentInstance.analyze(new Event("submit"));

    expect(api.get).toHaveBeenCalledWith("/imports/trello/auth-config");
    expect(fixture.componentInstance.canConnectTrello()).toBe(true);
  });

  it("imports into an existing standalone board without offering to replace its identity", async () => {
    api.request.mockResolvedValueOnce({ importId: "import-1", manifest: kaneraManifest() } satisfies AnalyzeKaneraBoardImportResponse);
    api.request.mockResolvedValueOnce(importResult());
    const fixture = TestBed.createComponent(TrelloImportPage);
    fixture.componentRef.setInput("source", "kanera");
    fixture.componentRef.setInput("workspaceId", "workspace-1");
    fixture.componentRef.setInput("standalone", true);
    fixture.componentRef.setInput("members", [workspaceMember()]);
    fixture.detectChanges();
    fixture.componentInstance.selectedFile.set(new File(["{}"], "board.json", { type: "application/json" }));

    await fixture.componentInstance.analyze(new Event("submit"));
    fixture.componentInstance.step.set("options");
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain("Cards are added to this board");
    expect(root.textContent).not.toContain("Board name");

    fixture.componentInstance.boardName.set("");
    await fixture.componentInstance.commit();
    fixture.detectChanges();

    expect(api.request.mock.calls[1]?.[0]).toBe("/imports/kanera-board/import-1/commit");
    const commitBody = JSON.parse((api.request.mock.calls[1]?.[1] as RequestInit).body as string) as CommitImportBody;
    expect(commitBody.board.name).toBe("Imported board");
    expect(root.textContent).toContain("1 card imported into this board");
  });

  it("sends the transient Trello token only on commit", async () => {
    api.request.mockResolvedValueOnce({ importId: "import-1", manifest: trelloManifest() } satisfies AnalyzeImportResponse);
    api.request.mockResolvedValueOnce(importResult());
    api.get.mockResolvedValueOnce({ enabled: true, apiKey: "trello-key" });
    const fixture = TestBed.createComponent(TrelloImportPage);
    fixture.componentRef.setInput("source", "trello");
    fixture.componentRef.setInput("workspaceId", "workspace-1");
    fixture.detectChanges();
    fixture.componentInstance.selectedFile.set(new File(["{}"], "trello.json", { type: "application/json" }));

    await fixture.componentInstance.analyze(new Event("submit"));
    fixture.componentInstance.trelloToken.set("trello-token");
    await fixture.componentInstance.commit();

    const commitCall = api.request.mock.calls[1] as unknown as [string, RequestInit];
    const commitInit = commitCall[1];
    const headers = commitInit.headers as Headers;
    const body = JSON.parse(commitInit.body as string) as CommitImportBody;
    expect(headers.get("X-Trello-Token")).toBe("trello-token");
    expect(body.options.attachmentCopyMode).toBe("copy");
    expect(importNavigationGuard.setImportRunning).toHaveBeenCalledWith(true);
    expect(importNavigationGuard.setImportRunning).toHaveBeenCalledWith(false);
  });

  it("asks for Trello authorization from the import action when uploaded attachments can be copied", async () => {
    api.request.mockResolvedValueOnce({ importId: "import-1", manifest: trelloManifest() } satisfies AnalyzeImportResponse);
    api.request.mockResolvedValueOnce(importResult());
    api.get.mockResolvedValueOnce({ enabled: true, apiKey: "trello-key" });
    const fixture = TestBed.createComponent(TrelloImportPage);
    fixture.componentRef.setInput("source", "trello");
    fixture.componentRef.setInput("workspaceId", "workspace-1");
    fixture.detectChanges();
    fixture.componentInstance.selectedFile.set(new File(["{}"], "trello.json", { type: "application/json" }));

    await fixture.componentInstance.analyze(new Event("submit"));
    const openTrelloAuthorize = vi.spyOn(fixture.componentInstance as unknown as { openTrelloAuthorize(apiKey: string): Promise<string> }, "openTrelloAuthorize")
      .mockResolvedValueOnce("trello-token");
    await fixture.componentInstance.commit();

    const commitCall = api.request.mock.calls[1] as unknown as [string, RequestInit];
    const headers = commitCall[1].headers as Headers;
    expect(openTrelloAuthorize).toHaveBeenCalledWith("trello-key");
    expect(headers.get("X-Trello-Token")).toBe("trello-token");
  });

  it("shows the completed result when status reports completion after a commit request failure", async () => {
    api.request.mockResolvedValueOnce({ importId: "import-1", manifest: trelloManifest() } satisfies AnalyzeImportResponse);
    api.request.mockRejectedValueOnce(new Error("connection closed"));
    api.get.mockResolvedValueOnce({ enabled: true, apiKey: "trello-key" });
    api.get.mockResolvedValue({ status: "completed", error: null, progress: null, result: importResult() });
    const fixture = TestBed.createComponent(TrelloImportPage);
    fixture.componentRef.setInput("source", "trello");
    fixture.componentRef.setInput("workspaceId", "workspace-1");
    fixture.detectChanges();
    fixture.componentInstance.selectedFile.set(new File(["{}"], "trello.json", { type: "application/json" }));

    await fixture.componentInstance.analyze(new Event("submit"));
    fixture.componentInstance.trelloToken.set("trello-token");
    await fixture.componentInstance.commit();

    expect(fixture.componentInstance.step()).toBe("result");
    expect(fixture.componentInstance.result()?.createdBoardId).toBe(importResult().createdBoardId);
    expect(fixture.componentInstance.error()).toBeNull();
  });
});
