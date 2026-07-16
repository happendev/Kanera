import { provideZonelessChangeDetection, signal } from "@angular/core";
import type { ComponentFixture} from "@angular/core/testing";
import { TestBed } from "@angular/core/testing";
import type { NoteAttachmentRow, WireNote, WireNoteLock } from "@kanera/shared/events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../../core/api/api.client";
import type { AuthUser } from "../../core/auth/auth.service";
import { AuthService } from "../../core/auth/auth.service";
import { STORAGE_KEYS } from "../../core/browser/browser-contracts";
import { SocketService } from "../../core/realtime/socket.service";
import { ConfirmService } from "../../shared/confirm.service";
import { ImageLightboxService } from "../board/image-lightbox.service";
import { NoteEditorComponent } from "./note-editor.component";
import { NotesState } from "./notes.service";

class NotesStateStub {
  lock: WireNoteLock | null = null;
  readonly acquireLock = vi.fn(async () => this.lock!);
  readonly releaseLock = vi.fn(async () => undefined);
  readonly updateNote = vi.fn(async (_id: string, patch: Partial<WireNote>) => ({ ...createNote(), ...patch }));
  readonly receiveLock = vi.fn((lock: WireNoteLock) => {
    this.lock = lock;
  });

  lockFor() {
    return this.lock;
  }

  isLockExpired(lock: Pick<WireNoteLock, "editingExpiresAt"> | null) {
    if (!lock) return true;
    return new Date(lock.editingExpiresAt).getTime() <= Date.now();
  }
}

class ApiClientStub {
  readonly get = vi.fn(async (_path: string): Promise<unknown> => []);
  readonly request = vi.fn(async (_path: string, _init?: RequestInit): Promise<unknown> => createAttachment());
  readonly upload = vi.fn(async (_path: string, _form: FormData, _opts?: { onProgress?: (pct: number) => void }): Promise<unknown> => createAttachment());
  readonly delete = vi.fn(async (_path: string): Promise<unknown> => undefined);
}

class SocketServiceStub {
  readonly displayedOnline = signal(true);
  readonly socket = { on: vi.fn(), off: vi.fn() };
  connect() {
    return this.socket;
  }
}

describe("NoteEditorComponent locking", () => {
  let fixture: ComponentFixture<NoteEditorComponent>;
  let state: NotesStateStub;
  let api: ApiClientStub;
  let confirm: { open: ReturnType<typeof vi.fn> };
  let imageLightbox: { open: ReturnType<typeof vi.fn> };
  let isOrgAdmin: ReturnType<typeof signal<boolean>>;
  let isPlanLimited: ReturnType<typeof signal<boolean>>;

  beforeEach(async () => {
    state = new NotesStateStub();
    api = new ApiClientStub();
    confirm = { open: vi.fn(async () => true) };
    imageLightbox = { open: vi.fn() };
    isOrgAdmin = signal(false);
    isPlanLimited = signal(false);

    await TestBed.configureTestingModule({
      imports: [NoteEditorComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: NotesState, useValue: state },
        { provide: ApiClient, useValue: api },
        { provide: AuthService, useValue: { user: signal<AuthUser | null>(currentUser()), isOrgAdmin, isPlanLimited } },
        { provide: ConfirmService, useValue: confirm },
        { provide: ImageLightboxService, useValue: imageLightbox },
        { provide: SocketService, useClass: SocketServiceStub },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(NoteEditorComponent);
    fixture.componentRef.setInput("note", createNote());
    fixture.componentRef.setInput("mentionMembers", [
      {
        userId: "user-2",
        displayName: "Ada Lovelace",
        avatarUrl: null,
        role: "editor",
        source: "workspace",
      },
    ]);
  });

  afterEach(() => {
    localStorage.removeItem(STORAGE_KEYS.EDITOR_DRAFTS);
    vi.restoreAllMocks();
  });

  it("shows the editing user in the banner and blank-note empty state", async () => {
    state.lock = createLock();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const text = native().textContent ?? "";
    expect(text).toContain("Ada Lovelace is editing this note");
    expect(text).toContain("Ada Lovelace is writing this note");
    expect(text).not.toContain("Add a description");
  });

  it("shows edit anyway once another user's lock has expired", async () => {
    state.lock = createLock({ editingExpiresAt: new Date(Date.now() - 1000).toISOString() });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(native().textContent).toContain("Edit anyway");
  });

  it("preserves the title draft when save conflicts with another user", async () => {
    fixture.componentRef.setInput("note", createNote({ editingUserId: null, editingExpiresAt: null }));
    state.lock = createLock({
      editingUserId: "user-1",
      editingUserName: "Owner",
    });
    state.updateNote.mockRejectedValueOnce(new ApiError(409, { code: "NOTE_LOCKED", lock: createLock() }));
    fixture.detectChanges();

    await fixture.componentInstance.startTitleEdit();
    fixture.componentInstance.title.set("Draft title");
    await fixture.componentInstance.saveTitle();
    fixture.detectChanges();

    expect(state.receiveLock).toHaveBeenCalledWith(expect.objectContaining({ editingUserName: "Ada Lovelace" }));
    expect(native().textContent).toContain("Your draft was preserved");
    expect(native().textContent).toContain("Unsaved draft");
    expect(native().textContent).not.toContain("Copy draft");
  });

  it("releases the lock when title editing ends without changes", async () => {
    fixture.componentRef.setInput("note", createNote({ editingUserId: null, editingExpiresAt: null }));
    state.lock = createLock({
      editingUserId: "user-1",
      editingUserName: "Owner",
    });
    fixture.detectChanges();

    await fixture.componentInstance.startTitleEdit();
    await fixture.componentInstance.saveTitle();

    expect(state.releaseLock).toHaveBeenCalledWith("note-1");
  });

  it("only sends one title update when enter and blur both save", async () => {
    fixture.componentRef.setInput("note", createNote({
      scope: "personal",
      editingUserId: null,
      editingExpiresAt: null,
    }));
    const titleSaved = deferred<WireNote>();
    state.updateNote.mockReturnValueOnce(titleSaved.promise);
    fixture.detectChanges();

    await fixture.componentInstance.startTitleEdit();
    fixture.componentInstance.title.set("Renamed note");
    const firstSave = fixture.componentInstance.saveTitle();
    const secondSave = fixture.componentInstance.saveTitle();
    titleSaved.resolve(createNote({ scope: "personal", title: "Renamed note" }));
    await Promise.all([firstSave, secondSave]);

    expect(state.updateNote).toHaveBeenCalledOnce();
    expect(state.updateNote).toHaveBeenCalledWith("note-1", expect.objectContaining({ title: "Renamed note" }));
    expect(fixture.componentInstance.saveError()).toBeNull();
  });

  it("does not enter title or body edit mode while offline", async () => {
    fixture.componentRef.setInput("note", createNote({ editingUserId: null, editingExpiresAt: null }));
    fixture.componentRef.setInput("canEdit", false);
    fixture.detectChanges();

    await fixture.componentInstance.startTitleEdit();
    await fixture.componentInstance.startBodyEdit();

    expect(fixture.componentInstance.editingTitle()).toBe(false);
    expect(fixture.componentInstance.editing()).toBe(false);
    expect(state.acquireLock).not.toHaveBeenCalled();
  });

  it("advances the concurrency base after the user changes the icon mid-edit", async () => {
    // Personal note so there's no lock in play — the only thing that should
    // matter for the save is the optimistic-concurrency base timestamp.
    const note = createNote({ scope: "personal", editingUserId: null, editingExpiresAt: null });
    fixture.componentRef.setInput("note", note);
    fixture.detectChanges();

    // Begin editing the body: captures the original updatedAt as the base.
    await fixture.componentInstance.startBodyEdit();

    // Changing the icon writes the note and bumps updatedAt on the server.
    const bumped = new Date("2026-05-22T00:00:00.000Z");
    state.updateNote.mockResolvedValueOnce({ ...note, icon: "star", updatedAt: bumped });
    fixture.componentInstance.onIconChange("star");
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Saving the body must use the bumped timestamp, not the stale original,
    // otherwise the user's own icon change trips a NOTE_STALE conflict.
    await fixture.componentInstance.onContentSave({ markdown: "Body", attachmentIds: [] });

    expect(state.updateNote).toHaveBeenLastCalledWith(
      "note-1",
      expect.objectContaining({ content: "Body", baseUpdatedAt: bumped.toISOString() }),
    );
    expect(fixture.componentInstance.saveError()).toBeNull();
  });

  it("advances the concurrency base after a title save while the body editor is open", async () => {
    const note = createNote({ scope: "personal", editingUserId: null, editingExpiresAt: null });
    fixture.componentRef.setInput("note", note);
    fixture.detectChanges();

    // Both editors open at once: body first, then the inline title.
    await fixture.componentInstance.startBodyEdit();
    await fixture.componentInstance.startTitleEdit();

    // Saving the title bumps updatedAt on the server.
    const bumped = new Date("2026-05-22T00:00:00.000Z");
    state.updateNote.mockResolvedValueOnce({ ...note, title: "Renamed", updatedAt: bumped });
    fixture.componentInstance.title.set("Renamed");
    await fixture.componentInstance.saveTitle();

    // The still-open body save must build on the bumped timestamp.
    await fixture.componentInstance.onContentSave({ markdown: "Body", attachmentIds: [] });

    expect(state.updateNote).toHaveBeenLastCalledWith(
      "note-1",
      expect.objectContaining({ content: "Body", baseUpdatedAt: bumped.toISOString() }),
    );
    expect(fixture.componentInstance.saveError()).toBeNull();
  });

  it("holds the shared lock until both the title and body edits finish", async () => {
    fixture.componentRef.setInput("note", createNote({ editingUserId: null, editingExpiresAt: null }));
    // Current user owns the lock (acquireLock returns it for both editors).
    state.lock = createLock({ editingUserId: "user-1", editingUserName: "Owner" });
    fixture.detectChanges();

    await fixture.componentInstance.startBodyEdit();
    await fixture.componentInstance.startTitleEdit();

    fixture.componentInstance.title.set("Renamed");
    await fixture.componentInstance.saveTitle();
    // Body editor is still open — the title save must not drop the shared lock.
    expect(state.releaseLock).not.toHaveBeenCalled();

    await fixture.componentInstance.onContentSave({ markdown: "Body", attachmentIds: [] });
    // Both edits are done now, so the lock is released.
    expect(state.releaseLock).toHaveBeenCalledWith("note-1");
  });

  it("saves note body changes as a local draft when save is pressed offline", async () => {
    fixture.componentRef.setInput("note", createNote({ content: "Saved body", editingUserId: null, editingExpiresAt: null }));
    fixture.componentRef.setInput("canEdit", false);
    fixture.detectChanges();

    await fixture.componentInstance.saveTitle();
    await fixture.componentInstance.onContentSave({ markdown: "Offline edit", attachmentIds: [] });

    const store = JSON.parse(localStorage.getItem(STORAGE_KEYS.EDITOR_DRAFTS) ?? "{}") as Record<string, { markdown?: string; baseMarkdown?: string }>;
    expect(state.updateNote).not.toHaveBeenCalled();
    expect(fixture.componentInstance.editing()).toBe(false);
    expect(fixture.componentInstance.recoveredBodyDraft()).toBe(true);
    expect(fixture.componentInstance.preservedDraft()).toBeNull();
    expect(fixture.componentInstance.saveError()).toBeNull();
    fixture.detectChanges();
    expect(native().textContent).toContain("Offline edit");
    expect(native().querySelector("k-draft-banner")).not.toBeNull();
    expect(store["note-body:user-1:note-1"]).toEqual(expect.objectContaining({
      markdown: "Offline edit",
      baseMarkdown: "Saved body",
    }));

    fixture.componentRef.setInput("canEdit", true);
    fixture.detectChanges();

    await vi.waitFor(() => expect(fixture.componentInstance.saveError()).toBeNull());
    expect(fixture.componentInstance.preservedDraft()).toBeNull();
    expect(fixture.componentInstance.recoveredBodyDraft()).toBe(true);
  });

  it("auto-opens a recovered note body draft when editable", async () => {
    const key = "note-body:user-1:note-1";
    localStorage.setItem(STORAGE_KEYS.EDITOR_DRAFTS, JSON.stringify({
      [key]: {
        key,
        userId: "user-1",
        kind: "note-body",
        entityId: "note-1",
        noteId: "note-1",
        markdown: "Recovered note body",
        baseMarkdown: "Saved body",
        updatedAt: new Date().toISOString(),
      },
    }));
    fixture.componentRef.setInput("note", createNote({ scope: "personal", content: "Saved body", editingUserId: null, editingExpiresAt: null }));
    fixture.detectChanges();

    await vi.waitFor(() => expect(fixture.componentInstance.editing()).toBe(true));

    expect(fixture.componentInstance.editorInitialValue()).toBe("Recovered note body");
    expect(fixture.nativeElement.textContent).toContain("Unsaved draft.");

    await fixture.componentInstance.onContentSave({ markdown: "Recovered note body", attachmentIds: [] });

    expect(localStorage.getItem(STORAGE_KEYS.EDITOR_DRAFTS)).toBe("{}");
  });

  it("keeps a recovered note body draft when another user holds the lock", async () => {
    const key = "note-body:user-1:note-1";
    localStorage.setItem(STORAGE_KEYS.EDITOR_DRAFTS, JSON.stringify({
      [key]: {
        key,
        userId: "user-1",
        kind: "note-body",
        entityId: "note-1",
        noteId: "note-1",
        markdown: "Recovered locked body",
        baseMarkdown: "Saved body",
        updatedAt: new Date().toISOString(),
      },
    }));
    state.lock = createLock({ editingUserId: "user-2", editingUserName: "Ada Lovelace" });
    fixture.componentRef.setInput("note", createNote({ scope: "team", content: "Saved body", editingUserId: "user-2", editingExpiresAt: new Date(state.lock!.editingExpiresAt) }));
    fixture.detectChanges();

    await vi.waitFor(() => expect(fixture.componentInstance.recoveredBodyDraft()).toBe(true));

    expect(fixture.componentInstance.editing()).toBe(false);
    expect(fixture.nativeElement.textContent).toContain("Unsaved draft - click to continue editing.");
    expect(fixture.nativeElement.textContent).toContain("Recovered locked body");
    expect(localStorage.getItem(STORAGE_KEYS.EDITOR_DRAFTS)).toContain("Recovered locked body");
  });

  it("renders note attachments with description source metadata", async () => {
    api.get.mockImplementation(async (path: string) => path.endsWith("/attachments") ? [createAttachment()] : { backlinks: [] });
    fixture.componentRef.setInput("note", createNote({ editingUserId: null, editingExpiresAt: null }));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const text = native().textContent ?? "";
    expect(text).toContain("Attachments");
    expect(text).toContain("spec.txt");
    expect(text).toContain("description");
    expect(text).toContain("Owner");
  });

  it("shows an upload validation error for unsupported files", async () => {
    fixture.componentRef.setInput("note", createNote({ editingUserId: null, editingExpiresAt: null }));
    fixture.detectChanges();

    await fixture.componentInstance.onAttachmentSelected({
      target: { files: [new File(["x"], "bad.exe", { type: "application/x-msdownload" })], value: "" },
    } as unknown as Event);
    fixture.detectChanges();

    expect(native().textContent).toContain("Unsupported file type");
    expect(api.upload).not.toHaveBeenCalled();
  });

  it("shows upgrade guidance when a free-plan note attachment is too large", async () => {
    isOrgAdmin.set(true);
    isPlanLimited.set(true);
    api.upload.mockRejectedValueOnce(new ApiError(400, { code: "FILE_TOO_LARGE", maxFileBytes: 5 * 1024 * 1024 }));
    fixture.componentRef.setInput("note", createNote({ editingUserId: null, editingExpiresAt: null }));
    fixture.detectChanges();

    await fixture.componentInstance.onAttachmentSelected({
      target: { files: [new File(["x"], "large.png", { type: "image/png" })], value: "" },
    } as unknown as Event);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(native().textContent).toContain("File is too large (max 5 MB). Upgrade your plan for higher file limits.");
    });
  });

  it("uploads files dropped onto the note shell outside the body editor", async () => {
    fixture.componentRef.setInput("note", createNote({ scope: "personal", editingUserId: null, editingExpiresAt: null }));
    fixture.detectChanges();

    const shell = native().querySelector(".ne-shell") as HTMLElement;
    const file = new File(["image"], "dropped.png", { type: "image/png" });
    const over = dragEvent("dragover", { files: [file], target: shell });

    document.dispatchEvent(over);
    fixture.detectChanges();

    expect(over.defaultPrevented).toBe(true);
    expect(fixture.componentInstance.attachmentDragActive()).toBe(true);

    const drop = dragEvent("drop", { files: [file], target: shell });
    document.dispatchEvent(drop);

    expect(drop.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(api.upload).toHaveBeenCalledWith(
      "/notes/note-1/attachments",
      expect.any(FormData),
      expect.objectContaining({ onProgress: expect.any(Function) }),
    ));
  });

  it("does not intercept drops inside the note body editor", async () => {
    fixture.componentRef.setInput("note", createNote({ scope: "personal", editingUserId: null, editingExpiresAt: null }));
    fixture.detectChanges();

    await fixture.componentInstance.startBodyEdit();
    fixture.detectChanges();

    const editor = native().querySelector("k-description-editor") as HTMLElement;
    const file = new File(["image"], "inline.png", { type: "image/png" });
    const drop = dragEvent("drop", { files: [file], target: editor });

    document.dispatchEvent(drop);

    expect(drop.defaultPrevented).toBe(false);
    expect(api.upload).not.toHaveBeenCalled();
  });

  it("clears the note drop hint when dragging onto the body editor", async () => {
    fixture.componentRef.setInput("note", createNote({ scope: "personal", editingUserId: null, editingExpiresAt: null }));
    fixture.detectChanges();

    const shell = native().querySelector(".ne-shell") as HTMLElement;
    const file = new File(["image"], "inline.png", { type: "image/png" });

    document.dispatchEvent(dragEvent("dragover", { files: [file], target: shell }));
    expect(fixture.componentInstance.attachmentDragActive()).toBe(true);

    await fixture.componentInstance.startBodyEdit();
    fixture.detectChanges();

    const editor = native().querySelector("k-description-editor") as HTMLElement;
    editor.dispatchEvent(dragEvent("dragover", { files: [file] }));

    expect(fixture.componentInstance.attachmentDragActive()).toBe(false);
  });

  it("deletes attachments after confirmation", async () => {
    fixture.componentRef.setInput("note", createNote({ editingUserId: null, editingExpiresAt: null }));
    fixture.componentInstance.attachments.set([createAttachment()]);
    fixture.detectChanges();

    await fixture.componentInstance.confirmDeleteAttachment("attachment-1", "spec.txt");
    fixture.detectChanges();

    expect(confirm.open).toHaveBeenCalledWith(expect.objectContaining({ title: 'Delete "spec.txt"?' }));
    expect(api.delete).toHaveBeenCalledWith("/notes/note-1/attachments/attachment-1");
    expect(fixture.componentInstance.attachments()).toEqual([]);
  });

  it("opens video attachments in the media lightbox instead of downloading them", async () => {
    fixture.componentRef.setInput("note", createNote({ editingUserId: null, editingExpiresAt: null }));
    fixture.detectChanges();
    await fixture.whenStable();
    const video = createAttachment({
      fileName: "demo.mp4",
      mimeType: "video/mp4",
      url: "https://example.com/demo.mp4",
    });
    fixture.componentInstance.attachments.set([video]);
    fixture.detectChanges();

    const playButton = native().querySelector(".ne-attach-thumb.is-video") as HTMLButtonElement;
    playButton.click();

    expect(imageLightbox.open).toHaveBeenCalledWith({
      src: "https://example.com/demo.mp4",
      fileName: "demo.mp4",
      createdAt: video.createdAt,
      mediaType: "video",
    }, expect.any(Event));
  });

  it("refreshes attachments after saving content with inline uploads", async () => {
    const note = createNote({ scope: "personal", editingUserId: null, editingExpiresAt: null });
    fixture.componentRef.setInput("note", note);
    api.get.mockImplementation(async (path: string) => path.endsWith("/attachments") ? [createAttachment({ id: "attachment-2" })] : { backlinks: [] });
    fixture.detectChanges();

    await fixture.componentInstance.onContentSave({ markdown: "Body", attachmentIds: ["attachment-2"] });
    await fixture.whenStable();

    expect(api.get).toHaveBeenCalledWith("/notes/note-1/attachments");
    expect(fixture.componentInstance.attachments().some((attachment) => attachment.id === "attachment-2")).toBe(true);
  });

  function native(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }
});

function createNote(overrides: Partial<WireNote> = {}): WireNote {
  return {
    id: "note-1",
    workspaceId: "workspace-1",
    boardId: null,
    parentNoteId: null,
    scope: "team",
    ownerId: "user-1",
    title: "Team note",
    content: "",
    icon: null,
    color: null,
    position: "1000.0000000000",
    editingUserId: "user-2",
    editingExpiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    updatedAt: new Date("2026-05-21T00:00:00.000Z"),
    ...overrides,
  };
}

function createAttachment(overrides: Partial<NoteAttachmentRow> = {}): NoteAttachmentRow {
  return {
    id: "attachment-1",
    noteId: "note-1",
    fileName: "spec.txt",
    mimeType: "text/plain",
    byteSize: 42,
    url: "/api/media/client-1/notes/note-1/spec.txt?fn=spec.txt",
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    uploadedById: "user-1",
    uploadedByName: "Owner",
    uploadedByAvatarUrl: null,
    source: "description",
    ...overrides,
  };
}

function createLock(overrides: Partial<WireNoteLock> = {}): WireNoteLock {
  return {
    noteId: "note-1",
    editingUserId: "user-2",
    editingUserName: "Ada Lovelace",
    editingUserAvatarUrl: null,
    editingExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function dragEvent(type: "dragover" | "drop", data: { files: File[]; target?: Element }): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(event, "dataTransfer", {
    value: {
      types: ["Files"],
      items: data.files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
      files: data.files,
      dropEffect: "none",
    },
  });
  if (data.target) {
    Object.defineProperty(event, "target", { value: data.target });
  }
  return event;
}

function currentUser(): AuthUser {
  return {
    id: "user-1",
    clientId: "client-1",
    email: "owner@example.com",
    displayName: "Owner",
    avatarUrl: null,
    orgName: "Acme",
    logoUrl: null,
    deploymentMode: "self_hosted",
    hasWorkspace: true,
    role: "owner",
    timezone: "UTC",
    storageUsage: {
      usedBytes: 0,
      quotaBytes: null,
      remainingBytes: null,
      limited: false,
      maxFileBytes: 250 * 1024 * 1024,
    },
  };
}
