import { provideZonelessChangeDetection, signal } from "@angular/core";
import type { ComponentFixture } from "@angular/core/testing";
import { TestBed } from "@angular/core/testing";
import type { WorkDoneEvent, WorkDoneResponse } from "@kanera/shared/dto";
import type { WireCardSummary } from "@kanera/shared/events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../../core/api/api.client";
import { BoardState } from "../board-state";
import { WorkDoneViewComponent } from "./work-done-view.component";

function cardSummary(overrides: Partial<WireCardSummary> & { id: string; title: string }): WireCardSummary {
  return {
    listId: "list-1",
    boardId: "board-1",
    position: "1000.0000000000",
    dueDateLocalDate: null,
    dueDateSlot: null,
    dueDateTimezone: null,
    completedAt: null,
    archivedAt: null,
    coverAttachmentId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    hasDescription: false,
    commentCount: 0,
    attachmentCount: 0,
    checklistDoneCount: 0,
    checklistTotalCount: 0,
    coverUrl: null,
    labelIds: [],
    assigneeIds: [],
    customFieldValues: [],
    ...overrides,
  } as WireCardSummary;
}

describe("WorkDoneViewComponent", () => {
  let fixture: ComponentFixture<WorkDoneViewComponent>;
  let api: { get: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    api = { get: vi.fn() };
    const boardState = {
      cardLabels: signal([]),
      members: signal([{ userId: "user-1", displayName: "Ada", avatarUrl: null, role: "editor", source: "workspace" }]),
      customFields: signal([]),
    };

    await TestBed.configureTestingModule({
      imports: [WorkDoneViewComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: api },
        { provide: BoardState, useValue: boardState },
      ],
    }).compileComponents();
  });

  async function render(response: WorkDoneResponse, inputs?: Record<string, unknown>) {
    api.get.mockResolvedValue(response);
    fixture = TestBed.createComponent(WorkDoneViewComponent);
    fixture.componentRef.setInput("scope", "board");
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("workspaceId", "workspace-1");
    fixture.componentRef.setInput("lists", [
      { id: "list-1", workspaceId: "workspace-1", name: "To Do", position: "1000.0000000000", color: null, icon: null, createdAt: new Date(), updatedAt: new Date() },
      { id: "list-2", workspaceId: "workspace-1", name: "Done", position: "2000.0000000000", color: null, icon: null, createdAt: new Date(), updatedAt: new Date() },
    ]);
    for (const [key, value] of Object.entries(inputs ?? {})) fixture.componentRef.setInput(key, value);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  const createdEvent: WorkDoneEvent = {
    id: "act-created",
    type: "created",
    at: "2026-05-21T08:00:00.000Z",
    card: cardSummary({ id: "card-1", title: "Ship it" }),
    boardId: "board-1",
    listId: "list-1",
    actorUserId: "user-1",
    actorName: "Ada",
    actorAvatarUrl: null,
  };
  const movedEvent: WorkDoneEvent = {
    id: "act-moved",
    type: "moved",
    at: "2026-05-21T09:00:00.000Z",
    card: cardSummary({ id: "card-1", title: "Ship it", listId: "list-2" }),
    boardId: "board-1",
    listId: "list-2",
    actorUserId: "user-2",
    actorName: "Bob",
    actorAvatarUrl: null,
    listPath: ["list-1", "list-2"],
  };
  const completedEvent: WorkDoneEvent = {
    id: "act-completed",
    type: "completed",
    at: "2026-05-21T10:00:00.000Z",
    card: cardSummary({ id: "card-2", title: "Wrap up" }),
    boardId: "board-1",
    listId: "list-2",
    actorUserId: "user-1",
    actorName: "Ada",
    actorAvatarUrl: null,
  };
  const checklistEvent: WorkDoneEvent = {
    id: "checklistItem:item-1",
    type: "checklistItemCompleted",
    at: "2026-05-21T11:00:00.000Z",
    card: cardSummary({ id: "card-3", title: "Release" }),
    boardId: "board-1",
    listId: "list-2",
    itemId: "item-1",
    text: "Verify production deploy",
    checklistId: "checklist-1",
    checklistTitle: "Release checks",
    completedByUserId: "user-1",
    completedByName: "Ada",
    completedByAvatarUrl: null,
  };

  it("renders created, moved, completed and checklist rows in descending time order", async () => {
    await render({ events: [checklistEvent, completedEvent, movedEvent, createdEvent] });

    const native = fixture.nativeElement as HTMLElement;
    const rows = native.querySelectorAll(".wd-row");
    expect(rows.length).toBe(4);
    expect(native.querySelector(".wd-summary")?.textContent?.trim()).toBe("4 events");

    // Order is whatever the server returned (sorted descending); first row is the latest.
    const verbs = Array.from(rows).map((row) => row.querySelector(".wd-verb")?.textContent?.trim());
    expect(verbs).toEqual(["Checked off", "Completed", "Moved", "Created"]);

    // Moved row shows the full list path the card travelled.
    const movedRow = rows[2]!;
    const pathNames = Array.from(movedRow.querySelectorAll(".wd-transition span")).map((el) => el.textContent?.trim());
    expect(pathNames).toEqual(["To Do", "Done"]);

    // Checklist row shows the item text and parent card title.
    const checklistRow = rows[0]!;
    expect(checklistRow.querySelector(".wd-card-title")?.textContent?.trim()).toBe("Verify production deploy");
    expect(checklistRow.querySelector(".wd-context-card")?.textContent?.trim()).toBe("Release");
  });

  it("collapses the middle of long move paths", async () => {
    const list = (id: string, name: string) => ({ id, workspaceId: "workspace-1", name, position: "1000.0000000000", color: null, icon: null, createdAt: new Date(), updatedAt: new Date() });
    const longMove: WorkDoneEvent = {
      id: "act-long-move",
      type: "moved",
      at: "2026-05-21T09:00:00.000Z",
      card: cardSummary({ id: "card-9", title: "Wanderer" }),
      boardId: "board-1",
      listId: "list-e",
      actorUserId: "user-1",
      actorName: "Ada",
      actorAvatarUrl: null,
      listPath: ["list-a", "list-b", "list-c", "list-d", "list-e"],
    };
    await render({ events: [longMove] }, {
      lists: [list("list-a", "A"), list("list-b", "B"), list("list-c", "C"), list("list-d", "D"), list("list-e", "E")],
    });

    const native = fixture.nativeElement as HTMLElement;
    const segments = Array.from(native.querySelectorAll(".wd-transition span")).map((el) => el.textContent?.trim());
    // First 3 lists, an ellipsis, then the final destination.
    expect(segments).toEqual(["A", "B", "C", "…", "E"]);
  });

  it("clicking a row opens the card", async () => {
    await render({ events: [completedEvent] });
    const opened = vi.fn();
    fixture.componentInstance.cardOpened.subscribe(opened);
    (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(".wd-row")?.click();
    expect(opened).toHaveBeenCalledWith("card-2");
  });

  it("marks the selected card's row", async () => {
    await render({ events: [completedEvent, createdEvent] }, { selectedCardId: "card-2" });
    const native = fixture.nativeElement as HTMLElement;
    const selected = native.querySelectorAll(".wd-row.is-selected");
    expect(selected.length).toBe(1);
    expect(selected[0]?.querySelector(".wd-card-title")?.textContent?.trim()).toBe("Wrap up");
  });

  it("member filter keeps card events by actor and checklist events by completedBy", async () => {
    // movedEvent's actor is user-2; created/completed/checklist are user-1.
    await render(
      { events: [checklistEvent, completedEvent, movedEvent, createdEvent] },
      { filterMemberIds: ["user-1"] },
    );
    const native = fixture.nativeElement as HTMLElement;
    const verbs = Array.from(native.querySelectorAll(".wd-row .wd-verb")).map((el) => el.textContent?.trim());
    // The moved row (actor user-2) is filtered out; the rest (user-1) remain.
    expect(verbs).toEqual(["Checked off", "Completed", "Created"]);
  });

  it("filters assigned-work history to multiple selected boards", async () => {
    const otherBoardEvent: WorkDoneEvent = {
      ...completedEvent,
      id: "act-other-board",
      boardId: "board-2",
      card: cardSummary({ id: "card-board-2", title: "Other board", boardId: "board-2" }),
    };
    const hiddenBoardEvent: WorkDoneEvent = {
      ...completedEvent,
      id: "act-hidden-board",
      boardId: "board-3",
      card: cardSummary({ id: "card-board-3", title: "Hidden board", boardId: "board-3" }),
    };

    await render(
      { events: [hiddenBoardEvent, otherBoardEvent, completedEvent] },
      { scope: "assigned", userId: "user-1", boardId: null, boardFilterIds: ["board-1", "board-2"] },
    );

    const titles = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll(".wd-card-title"))
      .map((element) => element.textContent?.trim());
    expect(titles).toEqual(["Other board", "Wrap up"]);
    expect(api.get.mock.calls.at(-1)?.[0]).not.toContain("boardId=");
  });
});
