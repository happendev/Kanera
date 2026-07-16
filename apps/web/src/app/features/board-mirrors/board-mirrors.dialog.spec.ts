import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { BoardMirrorRow } from "@kanera/shared/dto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../core/api/api.client";
import { BoardMirrorsDialogComponent } from "./board-mirrors.dialog";
import { BoardMirrorsService } from "./board-mirrors.service";

const now = new Date("2026-07-16T00:00:00.000Z");
function mirrorRow(overrides: Partial<BoardMirrorRow> = {}): BoardMirrorRow {
  return {
    id: "mirror-1",
    sourceBoardId: "source-board",
    sourceBoardName: "Source board",
    sourceWorkspaceId: "source-workspace",
    sourceWorkspaceName: "Source workspace",
    sourceOrganisationName: "Organisation",
    targetBoardId: "target-board",
    targetBoardName: "Target board",
    targetWorkspaceId: "target-workspace",
    targetWorkspaceName: "Target workspace",
    targetOrganisationName: "Organisation",
    createdById: "user-1",
    createdByName: "Owner",
    pausedAt: null,
    sourceDisabledAt: null,
    sourceDisabledByName: null,
    reconcileRequestedAt: null,
    lastSyncAt: now,
    consecutiveFailures: 0,
    nextRetryAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    lists: [],
    availableSourceLists: [],
    availableTargetLists: [],
    ...overrides,
  };
}

describe("BoardMirrorsDialogComponent", () => {
  const service = {
    inbound: vi.fn<() => Promise<BoardMirrorRow[]>>().mockResolvedValue([]),
    outbound: vi.fn<() => Promise<BoardMirrorRow[]>>().mockResolvedValue([]),
    update: vi.fn(() => Promise.resolve({})),
    sourceEnable: vi.fn(() => Promise.resolve({ ok: true })),
    sourceDisable: vi.fn(() => Promise.resolve({ ok: true })),
    remove: vi.fn(() => Promise.resolve(undefined)),
  };

  beforeEach(async () => {
    service.inbound.mockClear();
    service.outbound.mockClear();
    service.update.mockClear();
    service.sourceEnable.mockClear();
    service.sourceDisable.mockClear();
    service.remove.mockClear();
    await TestBed.configureTestingModule({
      imports: [BoardMirrorsDialogComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: BoardMirrorsService, useValue: service },
      ],
    }).compileComponents();
  });

  it("reloads inbound and outbound rows when realtime invalidates the dialog", async () => {
    const fixture = TestBed.createComponent(BoardMirrorsDialogComponent);
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.detectChanges();
    await vi.waitFor(() => expect(service.inbound).toHaveBeenCalledTimes(1));
    expect(service.outbound).toHaveBeenCalledTimes(1);

    fixture.componentRef.setInput("refreshVersion", 1);
    fixture.detectChanges();

    await vi.waitFor(() => expect(service.inbound).toHaveBeenCalledTimes(2));
    expect(service.outbound).toHaveBeenCalledTimes(2);
  });

  it("labels a board with incoming mirrors as a mirror target", async () => {
    service.inbound.mockResolvedValueOnce([mirrorRow()]);
    const fixture = TestBed.createComponent(BoardMirrorsDialogComponent);
    fixture.componentRef.setInput("boardId", "target-board");
    fixture.detectChanges();
    await fixture.whenStable();
    await vi.waitFor(() => expect(fixture.componentInstance.loading()).toBe(false));
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain("This board is a mirror target");
    expect((fixture.nativeElement as HTMLElement).textContent).toContain("cannot also be used as a mirror source");
  });

  it("shows the API topology conflict when re-enabling a legacy invalid mirror", async () => {
    const row = mirrorRow({ sourceDisabledAt: now });
    service.sourceEnable.mockRejectedValueOnce(new ApiError(409, { message: "a board cannot be both a mirror source and a mirror target" }));
    const fixture = TestBed.createComponent(BoardMirrorsDialogComponent);
    fixture.componentRef.setInput("boardId", "source-board");
    fixture.detectChanges();
    await fixture.whenStable();

    await fixture.componentInstance.toggleSource(row);

    expect(fixture.componentInstance.error()).toBe("a board cannot be both a mirror source and a mirror target");
  });
});
