import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { WireBoardMemberUser, WireCardSummary } from "@kanera/shared/events";
import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../core/api/api.client";
import { BoardState } from "./board-state";
import { BulkCardActionsMenuPopover } from "./bulk-card-actions-menu.popover";

function card(id: string, boardId: string, listId = "list-1"): WireCardSummary {
  return {
    id,
    boardId,
    listId,
    title: id,
    position: "1000.0000000000",
    dueDateLocalDate: null,
    dueDateSlot: null,
    dueDateTimezone: null,
    completedAt: null,
    archivedAt: null,
    coverAttachmentId: null,
    createdAt: new Date("2026-06-09T00:00:00.000Z"),
    updatedAt: new Date("2026-06-09T00:00:00.000Z"),
    hasDescription: false,
    commentCount: 0,
    attachmentCount: 0,
    checklistDoneCount: 0,
    checklistTotalCount: 0,
    coverUrl: null,
    labelIds: [],
    assigneeIds: [],
    customFieldValues: [],
  };
}

describe("BulkCardActionsMenuPopover", () => {
  async function createComponent(options: {
    patch?: ReturnType<typeof vi.fn>;
    post?: ReturnType<typeof vi.fn>;
    members?: WireBoardMemberUser[];
    currentUserId?: string | null;
  } = {}) {
    const patch = options.patch ?? vi.fn(() => Promise.resolve({ cards: [] }));
    const post = options.post ?? vi.fn(() => Promise.resolve({ cards: [] }));
    await TestBed.configureTestingModule({
      imports: [BulkCardActionsMenuPopover],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: { patch, post, get: vi.fn(() => Promise.resolve([])) } },
        {
          provide: BoardState,
          useValue: {
            updateCard: vi.fn(),
            labelIdsForCard: vi.fn(() => []),
            assigneeIdsForCard: vi.fn(() => []),
          },
        },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(BulkCardActionsMenuPopover);
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("cardIds", ["card-1", "card-2", "card-3"]);
    fixture.componentRef.setInput("cards", [card("card-1", "board-1"), card("card-2", "board-2"), card("card-3", "board-1")]);
    fixture.componentRef.setInput("lists", []);
    fixture.componentRef.setInput("labels", []);
    fixture.componentRef.setInput("members", options.members ?? []);
    fixture.componentRef.setInput("sourceWorkspaceId", "workspace-1");
    fixture.componentRef.setInput("currentUserId", options.currentUserId ?? null);
    fixture.componentRef.setInput("anchorPoint", { x: 20, y: 20 });
    fixture.detectChanges();
    return { fixture, patch, post };
  }

  it("splits board-scoped bulk requests when selected cards span boards", async () => {
    const patch = vi.fn(() => Promise.resolve({ cards: [] }));
    const { fixture } = await createComponent({ patch });

    await fixture.componentInstance.setCompletion({ preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as MouseEvent, true);

    expect(patch).toHaveBeenCalledWith("/boards/board-1/cards/bulk/completion", { cardIds: ["card-1", "card-3"], completed: true });
    expect(patch).toHaveBeenCalledWith("/boards/board-2/cards/bulk/completion", { cardIds: ["card-2"], completed: true });
  });

  it("batches list-wide selections to the API bulk limit", async () => {
    const patch = vi.fn((_url: string, _body: unknown) => Promise.resolve({ cards: [] }));
    const { fixture } = await createComponent({ patch });
    const cards = Array.from({ length: 201 }, (_, i) => card(`card-${i}`, "board-1"));
    fixture.componentRef.setInput("cardIds", cards.map((item) => item.id));
    fixture.componentRef.setInput("cards", cards);

    await fixture.componentInstance.setCompletion({ preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as MouseEvent, true);

    expect(patch).toHaveBeenCalledTimes(2);
    expect(patch.mock.calls[0]?.[1]).toEqual({ cardIds: cards.slice(0, 200).map((item) => item.id), completed: true });
    expect(patch.mock.calls[1]?.[1]).toEqual({ cardIds: ["card-200"], completed: true });
  });

  it("copies selected cards to a target board per source-board batch", async () => {
    const post = vi.fn((_url: string, _body: unknown) => Promise.resolve({ cards: [] }));
    const { fixture } = await createComponent({ post });

    await fixture.componentInstance.copyToBoard({ boardId: "target-board", listId: "target-list" });

    expect(post).toHaveBeenCalledWith("/boards/board-1/cards/bulk/duplicate", {
      cardIds: ["card-1", "card-3"],
      boardId: "target-board",
      listId: "target-list",
    });
    expect(post).toHaveBeenCalledWith("/boards/board-2/cards/bulk/duplicate", {
      cardIds: ["card-2"],
      boardId: "target-board",
      listId: "target-list",
    });
  });

  it("only offers a source list for board-copy auto-match when selected cards share one list", async () => {
    const { fixture } = await createComponent();

    expect(fixture.componentInstance.copyBoardSourceListId()).toBe("list-1");

    fixture.componentRef.setInput("cards", [card("card-1", "board-1", "list-1"), card("card-2", "board-2", "list-2"), card("card-3", "board-1", "list-1")]);
    fixture.detectChanges();

    expect(fixture.componentInstance.copyBoardSourceListId()).toBeNull();
  });

  it("shows the current assignable member as Me", async () => {
    const { fixture } = await createComponent({
      currentUserId: "user-1",
      members: [
        { userId: "user-2", displayName: "Ada", avatarUrl: null, role: "editor", source: "workspace" },
        { userId: "user-1", displayName: "Dylan", avatarUrl: null, role: "editor", source: "workspace" },
      ],
    });

    fixture.componentInstance.toggleSub({ preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as MouseEvent, "members");
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    const rows = Array.from(host.querySelectorAll<HTMLElement>(".cqe-row > span:not(.cqe-dot)")).map((row) => row.textContent?.trim());
    expect(rows[0]).toBe("Me");
    expect(rows).toContain("Ada");
  });

  it("opens submenus to the left when the menu is against the right viewport edge", async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
    try {
      const { fixture } = await createComponent();
      fixture.componentRef.setInput("anchorPoint", { x: 1000, y: 20 });
      window.dispatchEvent(new Event("resize"));

      expect((fixture.nativeElement as HTMLElement).classList.contains("submenu-opens-left")).toBe(true);
      expect((fixture.nativeElement as HTMLElement).classList.contains("submenu-overlays")).toBe(false);
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
    }
  });

  it("overlays submenus when the viewport cannot fit two panels", async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 400 });
    try {
      const { fixture } = await createComponent();
      fixture.componentRef.setInput("anchorPoint", { x: 380, y: 20 });
      window.dispatchEvent(new Event("resize"));

      expect((fixture.nativeElement as HTMLElement).classList.contains("submenu-overlays")).toBe(true);
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
    }
  });
});
