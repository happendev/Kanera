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
      .mockResolvedValueOnce([
        {
          id: "list-2",
          workspaceId: "workspace-2",
          name: "Ready",
          icon: null,
          color: null,
          position: "1000.0000000000",
          archivedAt: null,
          createdAt: new Date("2026-06-09T00:00:00.000Z"),
          updatedAt: new Date("2026-06-09T00:00:00.000Z"),
        },
      ]);
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
});
