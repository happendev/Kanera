import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { ActivatedRoute, Router } from "@angular/router";
import type { WireNote } from "@kanera/shared/events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../core/api/api.client";
import { AuthService } from "../../core/auth/auth.service";
import { notesSelectionKey, notesTabKey } from "../../core/browser/browser-contracts";
import { UnsavedWorkService } from "../../core/browser/unsaved-work.service";
import { ConfirmService } from "../../shared/confirm.service";
import { NotesState } from "./notes.service";
import { NotesViewComponent } from "./notes-view.component";

describe("NotesViewComponent", () => {
  beforeEach(() => localStorage.clear());

  async function create(initialNotes: WireNote[] = []) {
    const router = { navigate: vi.fn(() => Promise.resolve(true)) };
    const state = {
      online: signal(true),
      notes: signal(initialNotes),
      selectedId: signal<string | null>(null),
      init: vi.fn((_ctx: { workspaceId: string; boardId: string | null }) => Promise.resolve()),
      dispose: vi.fn(),
    };
    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: { get: vi.fn() } },
        { provide: AuthService, useValue: { user: signal(null) } },
        { provide: ConfirmService, useValue: {} },
        { provide: Router, useValue: router },
        { provide: ActivatedRoute, useValue: {} },
        { provide: UnsavedWorkService, useValue: { confirmNavigation: vi.fn(() => true) } },
      ],
    })
      .overrideComponent(NotesViewComponent, {
        set: {
          template: "",
          providers: [{
            provide: NotesState,
            useValue: state,
          }],
        },
      })
      .compileComponents();

    return { fixture: TestBed.createComponent(NotesViewComponent), router, state };
  }

  it("names the board for private notes and describes team notes", async () => {
    const { fixture } = await create();
    fixture.componentRef.setInput("workspaceId", "workspace-1");
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("contextName", "Product Roadmap");

    expect(fixture.componentInstance.tabDescription())
      .toBe("Your private notes for board Product Roadmap");

    fixture.componentInstance.activeTab.set("team");
    expect(fixture.componentInstance.tabDescription()).toBe("Notes shared with the team");
  });

  it("names the workspace for private notes", async () => {
    const { fixture } = await create();
    fixture.componentRef.setInput("workspaceId", "workspace-1");
    fixture.componentRef.setInput("contextName", "Delivery");

    expect(fixture.componentInstance.tabDescription())
      .toBe("Your private notes for workspace Delivery");
  });

  it("restores the last tab and its last selected note for this board", async () => {
    const notes = [
      createNote({ id: "personal-1", scope: "personal" }),
      createNote({ id: "team-1", scope: "team" }),
      createNote({ id: "team-2", scope: "team" }),
    ];
    localStorage.setItem(notesTabKey("board-1", "workspace-1"), "team");
    localStorage.setItem(notesSelectionKey("board-1", "workspace-1", "team"), "team-2");
    const { fixture, state } = await create(notes);
    fixture.componentRef.setInput("workspaceId", "workspace-1");
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("mentionMembers", []);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.componentInstance.activeTab()).toBe("team");
    expect(state.selectedId()).toBe("team-2");
  });

  it("selects the first note for a new section and remembers selections independently", async () => {
    const notes = [
      createNote({ id: "personal-1", scope: "personal" }),
      createNote({ id: "personal-2", scope: "personal" }),
      createNote({ id: "team-1", scope: "team" }),
      createNote({ id: "team-2", scope: "team" }),
    ];
    const { fixture, state } = await create(notes);
    fixture.componentRef.setInput("workspaceId", "workspace-1");
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("mentionMembers", []);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(state.selectedId()).toBe("personal-1");
    fixture.componentInstance.setTab("team");
    expect(state.selectedId()).toBe("team-1");
    fixture.componentInstance.selectNote("team-2");
    fixture.componentInstance.setTab("personal");
    expect(state.selectedId()).toBe("personal-1");
    fixture.componentInstance.selectNote("personal-2");
    fixture.componentInstance.setTab("team");
    expect(state.selectedId()).toBe("team-2");
    fixture.componentInstance.setTab("personal");
    expect(state.selectedId()).toBe("personal-2");
  });

  it("reloads notes and restores selection when the board section changes", async () => {
    const boardOneNotes = [createNote({ id: "board-1-note", boardId: "board-1" })];
    const boardTwoNotes = [
      createNote({ id: "board-2-personal", boardId: "board-2" }),
      createNote({ id: "board-2-team", boardId: "board-2", scope: "team" }),
    ];
    localStorage.setItem(notesTabKey("board-2", "workspace-1"), "team");
    localStorage.setItem(
      notesSelectionKey("board-2", "workspace-1", "team"),
      "board-2-team",
    );
    const { fixture, state } = await create(boardOneNotes);
    state.init.mockImplementation(async ({ boardId }) => {
      state.notes.set(boardId === "board-2" ? boardTwoNotes : boardOneNotes);
    });
    fixture.componentRef.setInput("workspaceId", "workspace-1");
    fixture.componentRef.setInput("boardId", "board-1");
    fixture.componentRef.setInput("mentionMembers", []);
    fixture.detectChanges();
    await fixture.whenStable();

    fixture.componentRef.setInput("boardId", "board-2");
    fixture.detectChanges();
    await fixture.whenStable();

    expect(state.init).toHaveBeenLastCalledWith({
      workspaceId: "workspace-1",
      boardId: "board-2",
    });
    expect(fixture.componentInstance.activeTab()).toBe("team");
    expect(state.selectedId()).toBe("board-2-team");
  });
});

function createNote(overrides: Partial<WireNote> = {}): WireNote {
  return {
    id: "note-1",
    workspaceId: "workspace-1",
    boardId: "board-1",
    parentNoteId: null,
    scope: "personal",
    ownerId: "user-1",
    lastEditedById: "user-1",
    lastEditedByName: "Owner",
    lastEditedByAvatarUrl: null,
    lastEditedAt: new Date("2026-07-01T00:00:00.000Z"),
    title: "Note",
    content: "",
    icon: null,
    color: null,
    position: "1000.0000000000",
    editingUserId: null,
    editingExpiresAt: null,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    ...overrides,
  };
}
