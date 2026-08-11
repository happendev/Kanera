import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { WireScratchpadNote } from "@kanera/shared/events";
import { SERVER_EVENTS } from "@kanera/shared/events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../core/api/api.client";
import { AuthService } from "../../core/auth/auth.service";
import { STORAGE_KEYS } from "../../core/browser/browser-contracts";
import { EditorDrafts } from "../../core/browser/editor-drafts";
import type { AppSocket } from "../../core/realtime/socket.service";
import { SocketService } from "../../core/realtime/socket.service";
import { ScratchpadService, type ScratchpadEditorBridge } from "./scratchpad.service";

const USER_ID = "60000000-0000-4000-8000-000000000001";
const NOTE_A = "70000000-0000-4000-8000-00000000000a";
const NOTE_B = "70000000-0000-4000-8000-00000000000b";

class SocketStub {
  readonly on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    const handlers = this.handlers.get(event) ?? new Set<(...args: unknown[]) => void>();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return this;
  });
  readonly off = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    this.handlers.get(event)?.delete(handler);
    return this;
  });
  private readonly handlers = new Map<string, Set<(...args: unknown[]) => void>>();

  trigger(event: string, ...args: unknown[]) {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }

  asSocket(): AppSocket {
    return this as unknown as AppSocket;
  }
}

/** A stand-in for the mounted TipTap editor, recording what the service asks it to do. */
class EditorStub implements ScratchpadEditorBridge {
  markClean = vi.fn((markdown: string) => {
    this.clean = markdown;
  });
  replaceWithCleanMarkdown = vi.fn((markdown: string) => {
    this.text = markdown;
    this.clean = markdown;
  });

  constructor(readonly noteId: string, private text = "", private clean = "") {}

  isDirty(): boolean {
    return this.text !== this.clean;
  }

  currentMarkdown(): string {
    return this.text;
  }

  /** Simulate the user typing without going through the service. */
  type(markdown: string) {
    this.text = markdown;
  }
}

function note(id: string, overrides: Partial<WireScratchpadNote> = {}): WireScratchpadNote {
  return {
    id,
    userId: USER_ID,
    clientId: "client-1",
    title: "Page",
    content: "",
    position: "1000.0000000000",
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
}

function setup(initial: WireScratchpadNote[] = [note(NOTE_A)]) {
  const socket = new SocketStub();
  const online = signal(true);
  const authUser = signal<{ id: string; clientId: string } | null>({ id: USER_ID, clientId: "client-1" });
  const get = vi.fn(async () => initial);
  const patch = vi.fn(async (path: string, body: unknown) => {
    const id = path.split("/")[3]!;
    const fields = body as { title?: string; content?: string };
    return note(id, {
      ...fields,
      // The server always advances updatedAt on an accepted write; the client leans on that as its
      // echo watermark, so the stub must too.
      updatedAt: new Date("2026-08-01T00:00:10.000Z"),
    });
  });
  const post = vi.fn(async () => note(NOTE_B, { position: "2000.0000000000" }));
  const del = vi.fn(async () => undefined);

  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: ApiClient, useValue: { get, post, patch, delete: del } },
      { provide: AuthService, useValue: { user: authUser.asReadonly() } },
      { provide: SocketService, useValue: { connect: vi.fn(() => socket.asSocket()), displayedOnline: online } },
    ],
  });

  const service = TestBed.inject(ScratchpadService);
  return { service, socket, get, patch, post, del, drafts: TestBed.inject(EditorDrafts), authUser, online };
}

describe("ScratchpadService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  it("never rewrites the editor from its own save echo", async () => {
    const { service, socket } = setup();
    service.initialise();
    await vi.runOnlyPendingTimersAsync();

    const editor = new EditorStub(NOTE_A);
    service.registerEditor(editor);

    service.updateContent(NOTE_A, "hello world");
    await vi.advanceTimersByTimeAsync(700);
    expect(editor.markClean).toHaveBeenCalledWith("hello world");

    // The server echoes our own write back to every session, including this one.
    socket.trigger(SERVER_EVENTS.SCRATCHPAD_NOTE_UPDATED, {
      note: note(NOTE_A, { content: "hello world", updatedAt: new Date("2026-08-01T00:00:10.000Z") }),
    });

    // Touching the document here would reset the cursor mid-sentence on every autosave tick.
    expect(editor.replaceWithCleanMarkdown).not.toHaveBeenCalled();
  });

  it("preserves blank-paragraph cursor state when an echo beats the autosave response", async () => {
    const { service, socket, patch } = setup([note(NOTE_A, { content: "thought" })]);
    service.initialise();
    await vi.runOnlyPendingTimersAsync();

    // TipTap does not serialize trailing empty paragraphs. After Enter, Enter the document has a
    // meaningful live cursor position, but both currentMarkdown() and the clean baseline still read
    // "thought", so the editor's semantic dirty check deliberately reports false.
    const editor = new EditorStub(NOTE_A, "thought", "thought");
    service.registerEditor(editor);
    let resolveSave!: (saved: WireScratchpadNote) => void;
    patch.mockImplementationOnce(() => new Promise((resolve) => {
      resolveSave = resolve;
    }));

    service.updateContent(NOTE_A, "thought");
    await vi.advanceTimersByTimeAsync(600);
    expect(patch).toHaveBeenCalledTimes(1);

    // The durable realtime echo can arrive before the HTTP response advances lastSavedAt. Replacing
    // the document here would strip the empty paragraphs and pull the cursor back into the text.
    socket.trigger(SERVER_EVENTS.SCRATCHPAD_NOTE_UPDATED, {
      note: note(NOTE_A, { content: "thought", updatedAt: new Date("2026-08-01T00:00:10.000Z") }),
    });

    expect(editor.isDirty()).toBe(false);
    expect(editor.replaceWithCleanMarkdown).not.toHaveBeenCalled();

    resolveSave(note(NOTE_A, { content: "thought", updatedAt: new Date("2026-08-01T00:00:10.000Z") }));
    await Promise.resolve();
  });

  it("applies a newer remote edit only while the editor is clean", async () => {
    const { service, socket } = setup();
    service.initialise();
    await vi.runOnlyPendingTimersAsync();

    const editor = new EditorStub(NOTE_A);
    service.registerEditor(editor);

    // Clean editor, genuinely newer payload — adopt it.
    socket.trigger(SERVER_EVENTS.SCRATCHPAD_NOTE_UPDATED, {
      note: note(NOTE_A, { content: "from my laptop", updatedAt: new Date("2026-08-01T00:05:00.000Z") }),
    });
    expect(editor.replaceWithCleanMarkdown).toHaveBeenCalledWith("from my laptop");

    // Now the user is mid-sentence. A remote edit must not take the words out from under them; the
    // pending autosave will win by last-write-wins instead.
    editor.type("I am still typing");
    socket.trigger(SERVER_EVENTS.SCRATCHPAD_NOTE_UPDATED, {
      note: note(NOTE_A, { content: "from my phone", updatedAt: new Date("2026-08-01T00:09:00.000Z") }),
    });
    expect(editor.replaceWithCleanMarkdown).toHaveBeenCalledTimes(1);
    expect(editor.currentMarkdown()).toBe("I am still typing");
  });

  it("adopts a remote edit wholesale for a page with no mounted editor", async () => {
    const { service, socket } = setup([note(NOTE_A), note(NOTE_B, { position: "2000.0000000000" })]);
    service.initialise();
    await vi.runOnlyPendingTimersAsync();
    service.registerEditor(new EditorStub(NOTE_A));

    socket.trigger(SERVER_EVENTS.SCRATCHPAD_NOTE_UPDATED, {
      note: note(NOTE_B, { content: "written elsewhere", position: "2000.0000000000", updatedAt: new Date("2026-08-01T00:05:00.000Z") }),
    });

    expect(service.notes().find((row) => row.id === NOTE_B)?.content).toBe("written elsewhere");
  });

  it("coalesces a burst of keystrokes into one request and never overlaps saves", async () => {
    const { service, patch } = setup();
    service.initialise();
    await vi.runOnlyPendingTimersAsync();
    service.registerEditor(new EditorStub(NOTE_A));

    service.updateContent(NOTE_A, "a");
    service.updateContent(NOTE_A, "ab");
    service.updateContent(NOTE_A, "abc");
    await vi.advanceTimersByTimeAsync(700);

    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith(`/scratchpad/notes/${NOTE_A}`, { content: "abc" });
  });

  it("flushes a pending save when the panel closes", async () => {
    const { service, patch } = setup();
    service.initialise();
    await vi.runOnlyPendingTimersAsync();
    service.setOpen(true);
    service.registerEditor(new EditorStub(NOTE_A));

    service.updateContent(NOTE_A, "not yet debounced");
    expect(patch).not.toHaveBeenCalled();

    // Closing unmounts the editor, so a queued save that never fired would be lost with it.
    service.setOpen(false);
    await vi.runOnlyPendingTimersAsync();

    expect(patch).toHaveBeenCalledWith(`/scratchpad/notes/${NOTE_A}`, { content: "not yet debounced" });
  });

  it("adopts recovered text once and then stops rewriting the page", async () => {
    const { service, drafts } = setup();
    service.initialise();
    await vi.runOnlyPendingTimersAsync();
    // Text this browser never got onto the server — a crash mid-edit, which is what recovery is for.
    drafts.save({
      userId: USER_ID,
      kind: "scratchpad-note",
      entityId: NOTE_A,
      markdown: "text the server never saw",
      baseMarkdown: "",
    });
    service.registerEditor(new EditorStub(NOTE_A));

    // The panel re-seeds its editor whenever the notes array changes, and the handoff below changes the
    // notes array. Replaying that pairing: the offer may legitimately keep standing until the save
    // lands, but the *write* must happen exactly once. Left re-entrant this is an unbounded loop — CPU
    // pegged, localStorage rewritten thousands of times a second (a synchronous, cross-tab resource, so
    // the user's other tabs freeze too), and the autosave debounce re-armed so often nothing ever saves.
    const current = () => service.notes().find((row) => row.id === NOTE_A)!;
    let writes = 0;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const recovered = service.recoveredMarkdown(current());
      if (recovered === null) break;
      const before = current();
      service.restoreRecoveredContent(NOTE_A, recovered);
      if (current() !== before) writes += 1;
    }

    expect(current().content).toBe("text the server never saw");
    expect(writes).toBe(1);
  });

  it("hands the dock back to the tab the scratchpad was popped out of", async () => {
    const { service } = setup();
    service.initialise();
    await vi.runOnlyPendingTimersAsync();

    // Popping out closes the dock in the tab that did it.
    service.setOpen(true);
    service.setOpen(false);
    expect(localStorage.getItem(STORAGE_KEYS.SCRATCHPAD_OPEN)).toBe("0");

    // The popped-out tab asking for the dock back must *write* the flag, because the write is the only
    // thing the other tab sees — it reacts to the `storage` event. Simulating that tab having already
    // flipped this one's signal is exactly the case `setOpen(true)` would early-return on.
    service.open.set(true);
    service.requestDock();
    expect(localStorage.getItem(STORAGE_KEYS.SCRATCHPAD_OPEN)).toBe("1");
  });

  it("flushes the outgoing page before switching tabs", async () => {
    const { service, patch } = setup([note(NOTE_A), note(NOTE_B, { position: "2000.0000000000" })]);
    service.initialise();
    await vi.runOnlyPendingTimersAsync();
    service.registerEditor(new EditorStub(NOTE_A));

    service.updateContent(NOTE_A, "half a thought");
    service.setActiveNote(NOTE_B);
    await vi.runOnlyPendingTimersAsync();

    expect(patch).toHaveBeenCalledWith(`/scratchpad/notes/${NOTE_A}`, { content: "half a thought" });
    expect(service.activeNoteId()).toBe(NOTE_B);
  });

  it("applies rebalanced positions before the moved page's own position", async () => {
    const { service, socket } = setup([
      note(NOTE_A, { position: "1000.0000000000" }),
      note(NOTE_B, { position: "1000.0000001000" }),
    ]);
    service.initialise();
    await vi.runOnlyPendingTimersAsync();

    // Server emit order. Applying `moved` first would place the page against numbers the rebalance
    // is about to renumber, leaving the tab in the wrong slot until the next full fetch.
    socket.trigger(SERVER_EVENTS.SCRATCHPAD_NOTE_REBALANCED, {
      positions: [
        { id: NOTE_A, position: "1000.0000000000" },
        { id: NOTE_B, position: "2000.0000000000" },
      ],
    });
    socket.trigger(SERVER_EVENTS.SCRATCHPAD_NOTE_MOVED, {
      noteId: NOTE_B,
      position: "500.0000000000",
      prevPosition: "2000.0000000000",
    });

    expect(service.notes().map((row) => row.id)).toEqual([NOTE_B, NOTE_A]);
  });

  it("moves to a neighbouring tab when the active page is deleted elsewhere", async () => {
    const { service, socket } = setup([note(NOTE_A), note(NOTE_B, { position: "2000.0000000000" })]);
    service.initialise();
    await vi.runOnlyPendingTimersAsync();
    service.setActiveNote(NOTE_A);

    socket.trigger(SERVER_EVENTS.SCRATCHPAD_NOTE_DELETED, { noteId: NOTE_A });

    expect(service.activeNoteId()).toBe(NOTE_B);
    expect(service.notes().map((row) => row.id)).toEqual([NOTE_B]);
  });

  it("keeps unsaved local text when a refetch lands mid-edit", async () => {
    const { service } = setup([note(NOTE_A, { content: "server copy" })]);
    service.initialise();
    await vi.runOnlyPendingTimersAsync();

    const editor = new EditorStub(NOTE_A, "server copy", "server copy");
    service.registerEditor(editor);
    editor.type("typing right now");
    service.updateContent(NOTE_A, "typing right now");

    await service.refresh();

    // A REST read is authoritative for everything except the body of a page being actively edited.
    expect(service.notes()[0]?.content).toBe("typing right now");
  });

  it("retains the pending patch when a save fails so the next flush retries it", async () => {
    const { service, patch } = setup();
    service.initialise();
    await vi.runOnlyPendingTimersAsync();
    service.registerEditor(new EditorStub(NOTE_A));

    patch.mockRejectedValueOnce(new Error("network"));
    service.updateContent(NOTE_A, "important");
    await vi.advanceTimersByTimeAsync(700);
    expect(service.saveState()).toBe("error");

    // The retried patch has no timer behind it — flushing is its retry path.
    service.flushAll();
    await vi.runOnlyPendingTimersAsync();

    expect(patch).toHaveBeenLastCalledWith(`/scratchpad/notes/${NOTE_A}`, { content: "important" });
    // Recovered. Not asserted as "saved": running pending timers also runs the "Saved" flash out to
    // idle, and either of those means the same thing here — the error cleared.
    expect(service.saveState()).not.toBe("error");
  });

  it("retries a failed autosave as soon as the connection returns", async () => {
    const { service, patch, online } = setup();
    service.initialise();
    await vi.runOnlyPendingTimersAsync();

    patch.mockRejectedValueOnce(new Error("network"));
    service.updateContent(NOTE_A, "retry me");
    await vi.advanceTimersByTimeAsync(700);
    expect(service.saveState()).toBe("error");

    online.set(false);
    TestBed.tick();
    online.set(true);
    TestBed.tick();
    await vi.runOnlyPendingTimersAsync();

    expect(patch).toHaveBeenCalledTimes(2);
    expect(patch).toHaveBeenLastCalledWith(`/scratchpad/notes/${NOTE_A}`, { content: "retry me" });
    expect(service.saveState()).not.toBe("error");
  });

  it("queues recovered text for autosave without waiting for another keypress", async () => {
    const { service, patch, drafts } = setup([note(NOTE_A, { content: "server copy" })]);
    drafts.save({
      userId: USER_ID,
      kind: "scratchpad-note",
      entityId: NOTE_A,
      markdown: "recovered copy",
      baseMarkdown: "server copy",
    });
    service.initialise();
    await vi.runOnlyPendingTimersAsync();

    const recovered = service.recoveredMarkdown(service.notes()[0]!);
    expect(recovered).toBe("recovered copy");
    service.restoreRecoveredContent(NOTE_A, recovered!);
    await vi.advanceTimersByTimeAsync(700);

    expect(patch).toHaveBeenCalledWith(`/scratchpad/notes/${NOTE_A}`, { content: "recovered copy" });
  });

  it("erases private state at an account boundary and ignores late saves", async () => {
    const { service, patch, authUser, get } = setup([note(NOTE_A, { content: "old account" })]);
    service.initialise();
    await vi.runOnlyPendingTimersAsync();

    let finishSave!: (value: WireScratchpadNote) => void;
    patch.mockImplementationOnce(() => new Promise((resolve) => {
      finishSave = resolve;
    }));
    service.updateContent(NOTE_A, "private in flight");
    service.flushAll();
    service.teardown();

    expect(service.notes()).toEqual([]);
    expect(service.activeNoteId()).toBeNull();
    expect(service.initialised()).toBe(false);

    const newUserId = "60000000-0000-4000-8000-000000000002";
    const newNote = note(NOTE_B, { userId: newUserId, content: "new account" });
    authUser.set({ id: newUserId, clientId: "client-2" });
    get.mockResolvedValueOnce([newNote]);
    service.initialise();
    await vi.runOnlyPendingTimersAsync();
    finishSave(note(NOTE_A, { content: "private in flight", updatedAt: new Date("2026-08-01T00:00:20.000Z") }));
    await Promise.resolve();

    expect(service.notes()).toEqual([newNote]);
    expect(service.notes().some((row) => row.id === NOTE_A)).toBe(false);
  });

  it("shows no saving indicator while the user is typing", async () => {
    const { service } = setup();
    service.initialise();
    await vi.runOnlyPendingTimersAsync();
    service.registerEditor(new EditorStub(NOTE_A));

    // A spinner appearing on every keystroke is the fidgeting a writing surface must not do, so
    // queuing a save has to leave the indicator alone — this is the regression that guards it.
    for (const text of ["a", "ab", "abc", "abcd"]) {
      service.updateContent(NOTE_A, text);
      await vi.advanceTimersByTimeAsync(120);
      expect(service.saveState()).toBe("idle");
    }

    // Nor does a healthy round trip ever reach "saving": the request resolves well inside the
    // indicator's delay, so the whole cycle is invisible apart from the "Saved" flash.
    await vi.advanceTimersByTimeAsync(700);
    expect(service.saveState()).toBe("saved");
  });

  it("names a blank page after the moment it is first written into", async () => {
    const { service, patch } = setup([note(NOTE_A, { title: "", content: "" })]);
    service.initialise();
    await vi.runOnlyPendingTimersAsync();
    service.registerEditor(new EditorStub(NOTE_A));

    service.updateContent(NOTE_A, "first words");
    await vi.advanceTimersByTimeAsync(700);

    const title = service.notes()[0]?.title ?? "";
    expect(title).not.toBe("");
    // The title rides along in the same coalesced patch rather than costing a second request.
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenLastCalledWith(`/scratchpad/notes/${NOTE_A}`, { content: "first words", title });

    // Fires exactly once: a later edit must never rename a page, and clearing the title of a page
    // that already has content is the user's decision to keep.
    service.renameNote(NOTE_A, "");
    service.updateContent(NOTE_A, "second words");
    await vi.advanceTimersByTimeAsync(700);
    expect(service.notes()[0]?.title).toBe("");
  });

  it("remembers the sheet height and clamps it to the viewport", () => {
    const { service } = setup();

    // Default is half the page — enough to write in, enough to still see what you are writing about.
    expect(service.sheetHeight()).toBe(Math.round(window.innerHeight * 0.5));

    service.setSheetHeight(320);
    service.persistSheetHeight();
    expect(service.sheetHeight()).toBe(320);

    // A height dragged on a taller device must not come back as a full-screen sheet.
    service.setSheetHeight(99_999);
    expect(service.sheetHeight()).toBeLessThan(window.innerHeight);
    service.setSheetHeight(10);
    expect(service.sheetHeight()).toBeGreaterThanOrEqual(220);
  });
});
