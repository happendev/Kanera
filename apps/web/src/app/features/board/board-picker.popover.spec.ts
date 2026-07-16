import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../core/api/api.client";
import { BoardPickerPopover } from "./board-picker.popover";

describe("BoardPickerPopover", () => {
  const get = vi.fn();

  const board = (id: string, workspaceId: string, name = id) => ({
    id,
    workspaceId,
    name,
    description: null,
    icon: null,
    iconColor: null,
    backgroundGradient: null,
    groupId: null,
    standaloneGroupId: null,
    position: "1000.0000000000",
    archivedAt: null,
    createdAt: new Date("2026-06-09T00:00:00.000Z"),
    updatedAt: new Date("2026-06-09T00:00:00.000Z"),
  });
  const list = (id: string, workspaceId: string, name: string) => ({
    id,
    workspaceId,
    name,
    icon: null,
    color: null,
    position: "1000.0000000000",
    archivedAt: null,
    createdAt: new Date("2026-06-09T00:00:00.000Z"),
    updatedAt: new Date("2026-06-09T00:00:00.000Z"),
  });

  beforeEach(async () => {
    get.mockReset();
    get.mockResolvedValue([]);
    await TestBed.configureTestingModule({
      imports: [BoardPickerPopover],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: { get } },
      ],
    }).compileComponents();
  });

  it("loads transfer targets through the source board authorization boundary", async () => {
    const fixture = TestBed.createComponent(BoardPickerPopover);
    fixture.componentRef.setInput("sourceBoardId", "board-1");
    fixture.componentRef.setInput("excludeBoardId", "board-1");
    fixture.detectChanges();

    await fixture.whenStable();

    expect(get).toHaveBeenCalledWith("/boards/board-1/transfer-targets");
  });

  it("loads cross-workspace targets only when opted in", async () => {
    const fixture = TestBed.createComponent(BoardPickerPopover);
    fixture.componentRef.setInput("sourceBoardId", "board-1");
    fixture.componentRef.setInput("excludeBoardId", "board-1");
    fixture.componentRef.setInput("allowCrossWorkspace", true);
    fixture.detectChanges();

    await fixture.whenStable();

    expect(get).toHaveBeenCalledWith("/boards/board-1/transfer-targets?crossWorkspace=1");
  });

  it("asks for a target list before emitting a cross-workspace board pick", async () => {
    get
      .mockResolvedValueOnce([board("board-2", "workspace-2", "External")])
      .mockResolvedValueOnce([list("list-2", "workspace-2", "Ready")]);
    const fixture = TestBed.createComponent(BoardPickerPopover);
    const picked = vi.fn();
    fixture.componentRef.setInput("sourceBoardId", "board-1");
    fixture.componentRef.setInput("excludeBoardId", "board-1");
    fixture.componentRef.setInput("allowCrossWorkspace", true);
    fixture.componentRef.setInput("sourceWorkspaceId", "workspace-1");
    fixture.componentInstance.pick.subscribe(picked);
    fixture.detectChanges();
    await fixture.whenStable();

    await fixture.componentInstance.selectBoard(board("board-2", "workspace-2", "External"));
    await fixture.whenStable();
    fixture.componentInstance.selectList("list-2");

    expect(get).toHaveBeenCalledWith("/boards/board-2/lists");
    expect(picked).toHaveBeenCalledWith({ boardId: "board-2", listId: "list-2" });
  });

  it("emits a cross-workspace board pick immediately when the target has one same-name list", async () => {
    get
      .mockResolvedValueOnce([board("board-2", "workspace-2", "External")])
      .mockResolvedValueOnce([list("target-planning", "workspace-2", "Planning"), list("target-review", "workspace-2", "Review")]);
    const fixture = TestBed.createComponent(BoardPickerPopover);
    const picked = vi.fn();
    fixture.componentRef.setInput("sourceBoardId", "board-1");
    fixture.componentRef.setInput("excludeBoardId", "board-1");
    fixture.componentRef.setInput("allowCrossWorkspace", true);
    fixture.componentRef.setInput("sourceWorkspaceId", "workspace-1");
    fixture.componentRef.setInput("sourceListId", "source-planning");
    fixture.componentRef.setInput("sourceLists", [list("source-planning", "workspace-1", "Planning")]);
    fixture.componentInstance.pick.subscribe(picked);
    fixture.detectChanges();
    await fixture.whenStable();

    await fixture.componentInstance.selectBoard(board("board-2", "workspace-2", "External"));
    await fixture.whenStable();

    expect(picked).toHaveBeenCalledWith({ boardId: "board-2", listId: "target-planning" });
    expect(fixture.componentInstance.phase()).toBe("boards");
  });

  it("asks for a target list when there is no same-name target list", async () => {
    get
      .mockResolvedValueOnce([board("board-2", "workspace-2", "External")])
      .mockResolvedValueOnce([list("target-review", "workspace-2", "Review")]);
    const fixture = TestBed.createComponent(BoardPickerPopover);
    const picked = vi.fn();
    fixture.componentRef.setInput("sourceBoardId", "board-1");
    fixture.componentRef.setInput("excludeBoardId", "board-1");
    fixture.componentRef.setInput("allowCrossWorkspace", true);
    fixture.componentRef.setInput("sourceWorkspaceId", "workspace-1");
    fixture.componentRef.setInput("sourceListId", "source-planning");
    fixture.componentRef.setInput("sourceLists", [list("source-planning", "workspace-1", "Planning")]);
    fixture.componentInstance.pick.subscribe(picked);
    fixture.detectChanges();
    await fixture.whenStable();

    await fixture.componentInstance.selectBoard(board("board-2", "workspace-2", "External"));
    await fixture.whenStable();

    expect(picked).not.toHaveBeenCalled();
    expect(fixture.componentInstance.phase()).toBe("lists");
  });

  it("asks for a target list when same-name target lists are ambiguous", async () => {
    get
      .mockResolvedValueOnce([board("board-2", "workspace-2", "External")])
      .mockResolvedValueOnce([list("target-planning-1", "workspace-2", "Planning"), list("target-planning-2", "workspace-2", "Planning")]);
    const fixture = TestBed.createComponent(BoardPickerPopover);
    const picked = vi.fn();
    fixture.componentRef.setInput("sourceBoardId", "board-1");
    fixture.componentRef.setInput("excludeBoardId", "board-1");
    fixture.componentRef.setInput("allowCrossWorkspace", true);
    fixture.componentRef.setInput("sourceWorkspaceId", "workspace-1");
    fixture.componentRef.setInput("sourceListId", "source-planning");
    fixture.componentRef.setInput("sourceLists", [list("source-planning", "workspace-1", "Planning")]);
    fixture.componentInstance.pick.subscribe(picked);
    fixture.detectChanges();
    await fixture.whenStable();

    await fixture.componentInstance.selectBoard(board("board-2", "workspace-2", "External"));
    await fixture.whenStable();

    expect(picked).not.toHaveBeenCalled();
    expect(fixture.componentInstance.phase()).toBe("lists");
  });
});
