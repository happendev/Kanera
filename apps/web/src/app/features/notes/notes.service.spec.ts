import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { WireNote } from "@kanera/shared/events";
import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../core/api/api.client";
import { OfflineCacheService } from "../../core/offline/offline-cache.service";
import { SocketService } from "../../core/realtime/socket.service";
import { NotesState } from "./notes.service";

function createNote(overrides: Partial<WireNote> = {}): WireNote {
  return {
    id: "note-1",
    workspaceId: "workspace-1",
    boardId: null,
    parentNoteId: null,
    scope: "team",
    ownerId: "user-1",
    lastEditedById: "user-1",
    lastEditedByName: "Owner",
    lastEditedByAvatarUrl: null,
    lastEditedAt: new Date("2026-07-01T00:00:00.000Z"),
    title: "Note",
    content: "",
    icon: null,
    iconColor: null,
    position: "1000",
    editingUserId: null,
    editingExpiresAt: null,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    ...overrides,
  } as WireNote;
}

describe("NotesState.hideNote", () => {
  function setup() {
    const api = { delete: vi.fn(() => Promise.resolve(undefined)) };
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        NotesState,
        { provide: ApiClient, useValue: api },
        { provide: OfflineCacheService, useValue: { saveNotes: vi.fn(() => Promise.resolve()) } },
        { provide: SocketService, useValue: { displayedOnline: signal(true) } },
      ],
    });
    const state = TestBed.inject(NotesState);
    state.notes.set([
      createNote({ id: "parent" }),
      createNote({ id: "child", parentNoteId: "parent" }),
      createNote({ id: "other" }),
    ]);
    state.selectedId.set("child");
    return { api, state };
  }

  it("hides the note and its sub-notes without a request, and Undo restores them and the selection", () => {
    const { api, state } = setup();
    const { restore } = state.hideNote("parent");
    expect(state.notes().map((n) => n.id)).toEqual(["other"]);
    expect(state.selectedId()).toBeNull();
    expect(api.delete).not.toHaveBeenCalled();

    restore();
    expect(state.notes().map((n) => n.id).sort()).toEqual(["child", "other", "parent"]);
    expect(state.selectedId()).toBe("parent");
    expect(api.delete).not.toHaveBeenCalled();
  });

  it("sends one DELETE on commit and puts the rows back if it fails", async () => {
    const { api, state } = setup();
    const { commit } = state.hideNote("parent");
    await commit();
    expect(api.delete).toHaveBeenCalledWith("/notes/parent");
    expect(state.notes().map((n) => n.id)).toEqual(["other"]);

    api.delete.mockRejectedValueOnce(new Error("boom"));
    const second = state.hideNote("other");
    await expect(second.commit()).rejects.toThrow("boom");
    expect(state.notes().map((n) => n.id)).toEqual(["other"]);
  });
});

describe("NotesState reconnect", () => {
  it("replaces both scopes after missed creates, updates and deletes", async () => {
    const handlers = new Map<string, () => void>();
    let team = [createNote({ id: "deleted" }), createNote({ id: "changed", title: "Before" })];
    const api = { get: vi.fn(async (path: string) => path.includes("scope=team") ? team : []) };
    const saveNotes = vi.fn().mockResolvedValue(undefined);
    TestBed.configureTestingModule({ providers: [
      provideZonelessChangeDetection(), NotesState,
      { provide: ApiClient, useValue: api },
      { provide: OfflineCacheService, useValue: { saveNotes } },
      { provide: SocketService, useValue: {
        displayedOnline: signal(true), joinWorkspace: () => vi.fn(),
        connect: () => ({ on: (name: string, handler: () => void) => handlers.set(name, handler), off: vi.fn() }),
      } },
    ] });
    const state = TestBed.inject(NotesState);
    await state.init({ workspaceId: "workspace-1", boardId: null });
    state.selectedId.set("deleted");
    team = [createNote({ id: "changed", title: "After" }), createNote({ id: "created" })];
    handlers.get("connect")!();
    await vi.waitFor(() => expect(state.notes().map((note) => note.id)).toEqual(["changed", "created"]));
    expect(state.notes()[0]?.title).toBe("After");
    expect(state.selectedId()).toBeNull();
    expect(saveNotes).toHaveBeenLastCalledWith("workspace-1", null, team);
    state.dispose();
  });
});
