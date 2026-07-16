import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { MirrorTargetBoard } from "@kanera/shared/dto";
import type { List } from "@kanera/shared/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../core/api/api.client";
import { BoardMirrorsService } from "./board-mirrors.service";
import { MirrorCreateDialogComponent } from "./mirror-create.dialog";

const now = new Date("2026-07-10T00:00:00.000Z");
function sourceList(id: string, name: string): List {
  return { id, workspaceId: "source-ws", name, icon: null, color: null, position: "1000.0000000000", archivedAt: null, createdAt: now, updatedAt: now };
}
function target(id: string, workspaceId: string, lists: Array<{ id: string; name: string }>): MirrorTargetBoard {
  return { id, name: id, workspaceId, workspaceName: workspaceId, organisationName: "Org", lists };
}

describe("MirrorCreateDialog", () => {
  const service = { targetBoards: vi.fn(), create: vi.fn() };
  beforeEach(async () => {
    service.targetBoards.mockReset(); service.create.mockReset();
    service.targetBoards.mockResolvedValue({ targets: [], sourceBlockedByIncomingMirror: false }); service.create.mockResolvedValue({});
    await TestBed.configureTestingModule({ imports: [MirrorCreateDialogComponent], providers: [provideZonelessChangeDetection(), { provide: BoardMirrorsService, useValue: service }] }).compileComponents();
  });

  async function fixtureFor(targets: MirrorTargetBoard[], sourceBlockedByIncomingMirror = false) {
    service.targetBoards.mockResolvedValue({ targets, sourceBlockedByIncomingMirror });
    const fixture = TestBed.createComponent(MirrorCreateDialogComponent);
    fixture.componentRef.setInput("sourceBoardId", "source-board");
    fixture.componentRef.setInput("sourceWorkspaceId", "source-ws");
    fixture.componentRef.setInput("sourceLists", [sourceList("planning", "Planning")]);
    fixture.detectChanges();
    await fixture.whenStable();
    await vi.waitFor(() => expect(fixture.componentInstance.loading()).toBe(false));
    fixture.detectChanges();
    expect(service.targetBoards).toHaveBeenCalledWith("source-board");
    return fixture;
  }

  it("uses identity mapping for same-workspace mirrors", async () => {
    const fixture = await fixtureFor([target("target-board", "source-ws", [{ id: "planning", name: "Planning" }])]);
    fixture.componentInstance.chooseTarget("target-board");
    fixture.componentInstance.toggleList("planning", true);
    await fixture.componentInstance.create();
    expect(service.create).toHaveBeenCalledWith("source-board", { targetBoardId: "target-board", lists: [{ sourceListId: "planning" }] });
  });

  it("name-prematches a unique cross-workspace target list", async () => {
    const fixture = await fixtureFor([target("target-board", "target-ws", [{ id: "target-planning", name: "Planning" }, { id: "review", name: "Review" }])]);
    fixture.componentInstance.chooseTarget("target-board");
    fixture.componentInstance.toggleList("planning", true);
    expect(fixture.componentInstance.targetListIds()["planning"]).toBe("target-planning");
    expect(fixture.componentInstance.canCreate()).toBe(true);
    await fixture.componentInstance.create();
    expect(service.create).toHaveBeenCalledWith("source-board", { targetBoardId: "target-board", lists: [{ sourceListId: "planning", targetListId: "target-planning" }] });
  });

  it("preserves the app-shell order returned for target workspaces and boards", async () => {
    const fixture = await fixtureFor([
      { ...target("second-board", "first-workspace", []), workspaceName: "First workspace" },
      { ...target("first-board", "first-workspace", []), workspaceName: "First workspace" },
      { ...target("third-board", "second-workspace", []), workspaceName: "Second workspace" },
    ]);

    expect(fixture.componentInstance.targetGroups().map((group) => ({
      workspaceName: group.workspaceName,
      boardIds: group.boards.map((board) => board.id),
    }))).toEqual([
      { workspaceName: "First workspace", boardIds: ["second-board", "first-board"] },
      { workspaceName: "Second workspace", boardIds: ["third-board"] },
    ]);
  });

  it("explains why a receiving board has no target selector", async () => {
    const fixture = await fixtureFor([], true);
    const host = fixture.nativeElement as HTMLElement;
    expect(fixture.componentInstance.sourceBlockedByIncomingMirror()).toBe(true);
    expect(host.textContent).toContain("This board is already a mirror target");
    expect(host.querySelector("select")).toBeNull();
  });

  it("shows missing list mappings as validation errors", async () => {
    const fixture = await fixtureFor([target("target-board", "target-ws", [{ id: "review", name: "Review" }])]);
    fixture.componentInstance.chooseTarget("target-board");
    fixture.componentInstance.step.set(2);
    fixture.componentInstance.toggleList("planning", true);
    await fixture.componentInstance.create();
    fixture.detectChanges();

    expect(service.create).not.toHaveBeenCalled();
    expect(fixture.componentInstance.error()).toBe("Choose a target list for every selected source list.");
    expect((fixture.nativeElement as HTMLElement).querySelector("select[aria-invalid='true']")).not.toBeNull();
  });

  it("clears a stale target and refreshes eligible options after a topology conflict", async () => {
    const fixture = await fixtureFor([target("target-board", "source-ws", [{ id: "planning", name: "Planning" }])]);
    fixture.componentInstance.chooseTarget("target-board");
    fixture.componentInstance.step.set(2);
    fixture.componentInstance.toggleList("planning", true);
    service.create.mockRejectedValueOnce(new ApiError(409, { message: "a board cannot be both a mirror source and a mirror target" }));
    service.targetBoards.mockResolvedValue({ targets: [], sourceBlockedByIncomingMirror: true });

    await fixture.componentInstance.create();

    expect(service.targetBoards).toHaveBeenCalledTimes(2);
    expect(fixture.componentInstance.step()).toBe(1);
    expect(fixture.componentInstance.targetBoardId()).toBe("");
    expect(fixture.componentInstance.sourceBlockedByIncomingMirror()).toBe(true);
    expect(fixture.componentInstance.error()).toContain("no longer available");
  });
});
