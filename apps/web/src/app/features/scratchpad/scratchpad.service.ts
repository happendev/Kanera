import { computed, effect, inject, Injectable, signal } from "@angular/core";
import { SERVER_EVENTS, type ServerToClientEvents, type WireScratchpadNote } from "@kanera/shared/events";
import { ApiClient } from "../../core/api/api.client";
import { AuthService } from "../../core/auth/auth.service";
import { scratchpadActiveNoteKey, STORAGE_KEYS } from "../../core/browser/browser-contracts";
import { EditorDrafts } from "../../core/browser/editor-drafts";
import { registerSocketHandlers } from "../../core/realtime/socket-handlers";
import { SocketService } from "../../core/realtime/socket.service";

/**
 * Autosave debounce. Long enough that ordinary typing produces one request per pause rather than one
 * per word, short enough that "Saved" appears while the user is still looking at the page. Every
 * boundary that could lose text (tab switch, panel close, window blur, pagehide, teardown) flushes
 * instead of waiting for it, so the debounce only ever delays a save, never risks one.
 */
const AUTOSAVE_DEBOUNCE_MS = 600;
/** How long "Saved" lingers before the indicator goes quiet again. */
const SAVED_FLASH_MS = 1600;
/**
 * How long a save must already have been in flight before a spinner is shown.
 *
 * Typing must never put a spinner on screen. Queuing a save therefore does not touch the indicator
 * at all, and even a real in-flight request stays silent for this long — on a healthy connection a
 * PATCH finishes well inside it, so the whole autosave cycle is invisible apart from the "Saved"
 * flash. A spinner appearing at all is information: the network is slow enough to be worth knowing
 * about.
 */
const SAVING_INDICATOR_DELAY_MS = 450;

export const SCRATCHPAD_MIN_WIDTH = 320;
export const SCRATCHPAD_MAX_WIDTH = 720;
export const SCRATCHPAD_DEFAULT_WIDTH = 420;
/** Bottom-sheet geometry. Tall enough to write in; never so tall the page behind it is unreachable. */
export const SCRATCHPAD_MIN_SHEET_HEIGHT = 220;
const SHEET_VIEWPORT_RESERVE = 72;
const SHEET_DEFAULT_FRACTION = 0.5;
/**
 * Mirrors `MAX_SCRATCHPAD_NOTES` in `@kanera/shared/schema` — importing the value would pull Drizzle
 * into the browser bundle, so the web keeps its own copy (same pattern Global Work uses for the
 * priority-queue cap). Only ever a UI affordance: the server enforces the real cap, and this exists
 * so the "+" button can disable itself instead of producing a 400.
 */
export const MAX_SCRATCHPAD_NOTES = 50;

export type ScratchpadSaveState = "idle" | "saving" | "saved" | "error";

/**
 * The live editor for the active page, as the service needs to see it.
 *
 * The panel registers one of these rather than the service reaching for a component: the echo rule
 * below needs to *ask* whether the document is dirty and to re-baseline it after an ack, and both of
 * those are editor operations whose ordering matters. Keeping the watermark and these two calls in
 * one place is what stops a remote update and an in-flight save from fighting.
 */
export interface ScratchpadEditorBridge {
  noteId: string;
  /** Re-baseline the saved value without touching the document. */
  markClean(markdown: string): void;
  /** Replace the document wholesale (only ever called on a clean editor). */
  replaceWithCleanMarkdown(markdown: string): void;
  isDirty(): boolean;
  currentMarkdown(): string;
}

type PendingPatch = { title?: string; content?: string };

/**
 * The signed-in user's private scratchpad.
 *
 * Root-provided and shell-owned, because the panel is app-wide chrome: it must survive navigation
 * between boards without losing an in-flight save or the tab you were on. Nothing here is shared with
 * anyone — every read and write is scoped to the requester server-side, and every realtime event
 * arrives on the user's own room.
 */
@Injectable({ providedIn: "root" })
export class ScratchpadService {
  private readonly api = inject(ApiClient);
  private readonly auth = inject(AuthService);
  private readonly sockets = inject(SocketService);
  private readonly drafts = inject(EditorDrafts);

  private readonly _notes = signal<WireScratchpadNote[]>([]);
  /** Position-sorted, which is the tab-strip order. */
  readonly notes = computed(() =>
    [...this._notes()].sort((a, b) => Number(a.position) - Number(b.position) || a.id.localeCompare(b.id)),
  );
  readonly activeNoteId = signal<string | null>(null);
  readonly activeNote = computed(() => this.notes().find((note) => note.id === this.activeNoteId()) ?? null);

  readonly open = signal(this.readOpen());
  readonly width = signal(this.readWidth());
  readonly sheetHeight = signal(this.readSheetHeight());
  readonly loading = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly saveState = signal<ScratchpadSaveState>("idle");
  readonly initialised = signal(false);
  readonly atCapacity = computed(() => this.notes().length >= MAX_SCRATCHPAD_NOTES);
  readonly online = this.sockets.displayedOnline;

  private editor: ScratchpadEditorBridge | null = null;
  private detach: (() => void) | null = null;
  private requestVersion = 0;
  /** Invalidates autosave callbacks that outlive a logout or organisation switch. */
  private lifecycleVersion = 0;
  private savedFlashTimer: ReturnType<typeof setTimeout> | null = null;
  /** Armed when a request goes on the wire; only its firing ever shows a spinner. */
  private savingIndicatorTimer: ReturnType<typeof setTimeout> | null = null;
  private listeningToWindow = false;

  /** Per-note debounce timers, pending field patches, and in-flight guards. */
  private readonly saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pending = new Map<string, PendingPatch>();
  private readonly inFlight = new Map<string, PendingPatch>();

  /**
   * Echo watermark: the newest `updatedAt` this tab is responsible for, per note.
   *
   * The server emits `scratchpadNote:updated` to every session the user has — including the one that
   * just saved. Without this, our own echo would arrive and rewrite the editor with text that is
   * already in it, moving the cursor mid-sentence on every autosave tick.
   */
  private readonly lastSavedAt = new Map<string, number>();
  /** Last server-acknowledged body per note, used as the draft's base so an ack clears the draft. */
  private readonly lastAckedContent = new Map<string, string>();

  private wasOnline = this.online();

  private readonly onVisibilityChange = () => {
    if (document.visibilityState !== "visible" || !this.initialised()) return;
    // A backgrounded tab can hold a socket that silently stopped delivering, so foregrounding is a
    // convergence boundary in its own right even when nothing looked wrong.
    void this.refresh();
  };
  /**
   * Blur and pagehide are the last moments text is still recoverable. `pagehide` in particular is the
   * only reliable "the tab is going away" signal on iOS Safari — `beforeunload` never fires there.
   */
  private readonly onWindowBlur = () => this.flushAll();
  private readonly onPageHide = () => this.flushAll();
  private readonly onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEYS.SCRATCHPAD_OPEN) this.open.set(event.newValue !== "0");
    if (event.key === STORAGE_KEYS.SCRATCHPAD_WIDTH) this.width.set(this.clampWidth(Number(event.newValue)));
    if (event.key === STORAGE_KEYS.SCRATCHPAD_SHEET_HEIGHT) {
      this.sheetHeight.set(this.clampSheetHeight(Number(event.newValue)));
    }
    const activeKey = this.activeKey();
    if (activeKey && event.key === activeKey && event.newValue) this.activeNoteId.set(event.newValue);
  };

  constructor() {
    // Reconnect is the other convergence boundary: events missed while offline are never replayed.
    effect(() => {
      const online = this.online();
      if (!this.initialised()) {
        this.wasOnline = online;
        return;
      }
      if (online && !this.wasOnline) {
        // A failed PATCH remains queued without a timer so it cannot spin against a dead network.
        // Reconnection is the safe retry boundary: send the user's text first, then converge any
        // events that were missed while the socket was down.
        this.flushAll();
        void this.refresh();
      }
      this.wasOnline = online;
    });
  }

  /**
   * Attach realtime and load the pages. Called on first open, not at startup: a user who never opens
   * the scratchpad should never pay for its fetch.
   */
  initialise(): void {
    if (this.initialised()) return;
    this.initialised.set(true);
    this.restoreActiveNoteId();
    this.attachSocket();
    if (typeof document !== "undefined" && !this.listeningToWindow) {
      this.listeningToWindow = true;
      document.addEventListener("visibilitychange", this.onVisibilityChange);
      window.addEventListener("blur", this.onWindowBlur);
      window.addEventListener("pagehide", this.onPageHide);
      window.addEventListener("storage", this.onStorage);
    }
    void this.refresh();
  }

  /** Organisation switch or sign-out: flush what we can, then drop everything. */
  teardown(): void {
    this.flushAll();
    // `flushAll` starts requests synchronously. Invalidate their callbacks before clearing the maps
    // below so an old account's late response can never repopulate root-provided state for the next
    // account using this SPA instance.
    this.lifecycleVersion += 1;
    this.detach?.();
    this.detach = null;
    for (const timer of this.saveTimers.values()) clearTimeout(timer);
    this.saveTimers.clear();
    this.pending.clear();
    this.inFlight.clear();
    if (this.savingIndicatorTimer) clearTimeout(this.savingIndicatorTimer);
    this.savingIndicatorTimer = null;
    if (this.savedFlashTimer) clearTimeout(this.savedFlashTimer);
    this.savedFlashTimer = null;
    this.lastSavedAt.clear();
    this.lastAckedContent.clear();
    if (this.listeningToWindow) {
      this.listeningToWindow = false;
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
      window.removeEventListener("blur", this.onWindowBlur);
      window.removeEventListener("pagehide", this.onPageHide);
      window.removeEventListener("storage", this.onStorage);
    }
    // Bump the version so an in-flight response cannot land in the next session.
    this.requestVersion += 1;
    this.initialised.set(false);
    this.editor = null;
    this._notes.set([]);
    this.activeNoteId.set(null);
    this.loading.set(false);
    this.loadError.set(null);
    this.saveState.set("idle");
  }

  // ── Panel state ────────────────────────────────────────────────────────────

  toggle(): void {
    this.setOpen(!this.open());
  }

  setOpen(open: boolean): void {
    if (open === this.open()) return;
    // Closing is a flush boundary: the panel unmounts its editor, so a debounced save that has not
    // fired yet would otherwise be dropped along with it.
    if (!open) this.flushAll();
    this.open.set(open);
    this.writeStorage(STORAGE_KEYS.SCRATCHPAD_OPEN, open ? "1" : "0");
    if (open) this.initialise();
  }

  /**
   * Put the dock back, from the popped-out tab.
   *
   * Deliberately not `setOpen(true)`: the *point* of this write is the `storage` event it raises in the
   * tab the scratchpad was popped out of, and `setOpen` returns early when the flag already matches —
   * which is exactly the case after another tab has re-opened its own dock. Writing unconditionally is
   * what guarantees the opener gets its dock back.
   */
  requestDock(): void {
    this.open.set(true);
    this.writeStorage(STORAGE_KEYS.SCRATCHPAD_OPEN, "1");
    this.initialise();
  }

  setWidth(width: number): void {
    this.width.set(this.clampWidth(width));
  }

  persistWidth(): void {
    this.writeStorage(STORAGE_KEYS.SCRATCHPAD_WIDTH, String(this.width()));
  }

  setSheetHeight(height: number): void {
    this.sheetHeight.set(this.clampSheetHeight(height));
  }

  persistSheetHeight(): void {
    this.writeStorage(STORAGE_KEYS.SCRATCHPAD_SHEET_HEIGHT, String(this.sheetHeight()));
  }

  setActiveNote(noteId: string | null): void {
    if (noteId === this.activeNoteId()) return;
    // The outgoing page's editor is about to be destroyed, so its pending text has to go now.
    this.flushAll();
    this.editor = null;
    this.activeNoteId.set(noteId);
    const key = this.activeKey();
    if (key && noteId) this.writeStorage(key, noteId);
  }

  /** The panel calls this whenever the mounted editor changes (note switch, mount, unmount). */
  registerEditor(bridge: ScratchpadEditorBridge | null): void {
    this.editor = bridge;
  }

  // ── Loading ────────────────────────────────────────────────────────────────

  async refresh(): Promise<void> {
    if (!this.auth.user()) return;
    if (!this.online()) {
      this.loading.set(false);
      // Not an error banner on a warm panel: whatever is already on screen is still the user's text,
      // and the drafts layer is holding anything unsaved.
      if (this._notes().length === 0) this.loadError.set("You're offline. Reconnect to load your scratchpad.");
      return;
    }
    const version = ++this.requestVersion;
    this.loading.set(true);
    try {
      const notes = await this.api.get<WireScratchpadNote[]>("/scratchpad/notes");
      if (version !== this.requestVersion) return;
      this.applyNotes(notes);
      this.loadError.set(null);
    } catch {
      if (version !== this.requestVersion) return;
      this.loadError.set("Couldn't load your scratchpad. Try again in a moment.");
    } finally {
      if (version === this.requestVersion) this.loading.set(false);
    }
  }

  /**
   * Adopt a server list.
   *
   * A REST read is authoritative for everything except a page whose editor is *currently dirty*: the
   * user's unsaved keystrokes outrank a body the server has not seen yet. Everything else — titles,
   * positions, other pages' bodies — is replaced.
   */
  private applyNotes(notes: WireScratchpadNote[]): void {
    const dirtyActiveId = this.editor && this.editor.isDirty() ? this.editor.noteId : null;
    const previous = new Map(this._notes().map((note) => [note.id, note]));
    this._notes.set(notes.map((note) => {
      if (note.id !== dirtyActiveId) {
        this.lastAckedContent.set(note.id, note.content);
        return note;
      }
      const local = previous.get(note.id);
      return local ? { ...note, content: local.content } : note;
    }));
    for (const note of notes) {
      this.lastSavedAt.set(note.id, Math.max(this.lastSavedAt.get(note.id) ?? 0, this.timestamp(note.updatedAt)));
    }
    this.ensureActiveNote();
  }

  /** Keep a tab selected: the remembered one if it still exists, otherwise the first page. */
  private ensureActiveNote(): void {
    const notes = this.notes();
    const current = this.activeNoteId();
    if (current && notes.some((note) => note.id === current)) return;
    this.setActiveNote(notes[0]?.id ?? null);
  }

  // ── Mutations ──────────────────────────────────────────────────────────────

  async createNote(title = ""): Promise<WireScratchpadNote | null> {
    if (this.atCapacity()) return null;
    try {
      const note = await this.api.post<WireScratchpadNote>("/scratchpad/notes", title ? { title } : {});
      this.upsert(note);
      // Switch to it deliberately rather than waiting for the realtime echo: pressing "+" is a
      // request to start writing, and the echo may be a round trip away.
      this.setActiveNote(note.id);
      return note;
    } catch {
      this.saveState.set("error");
      return null;
    }
  }

  /** Rename. Debounced through the same pipeline as the body so typing a title is not a request storm. */
  renameNote(noteId: string, title: string): void {
    this._notes.update((notes) => notes.map((note) => (note.id === noteId ? { ...note, title } : note)));
    this.queueSave(noteId, { title });
  }

  /** Body change from the editor. Drafts first, then the debounced save. */
  updateContent(noteId: string, markdown: string): void {
    const before = this._notes().find((note) => note.id === noteId);
    this._notes.update((notes) => notes.map((note) => (note.id === noteId ? { ...note, content: markdown } : note)));
    this.syncDraft(noteId, markdown);
    // A page that is written into while still unnamed gets named after the moment it was started, so
    // the tab strip is never a row of identical "Untitled" pills the user has to open to tell apart.
    // Gated on the page having been *empty* until now, which is what makes this fire exactly once —
    // it can never rename a page later, and it can never fight someone who deliberately cleared the
    // title of a page that already has content.
    if (before && !before.title.trim() && !before.content.trim() && markdown.trim()) {
      this.renameNote(noteId, this.defaultTitle());
    }
    this.queueSave(noteId, { content: markdown });
  }

  /**
   * Put a crash-recovered body through the ordinary autosave pipeline as soon as it is shown.
   * TipTap intentionally does not emit `onUpdate` for initial content, so without this explicit
   * handoff recovered text would look editable while remaining browser-local until another keypress.
   *
   * Idempotent, and that is load-bearing rather than tidiness. The caller is an effect that re-runs
   * when the notes array changes, and `updateContent` changes the notes array — so a handoff that
   * repeated itself became an unbounded loop: CPU pegged, `localStorage` rewritten thousands of times a
   * second (which is a synchronous, cross-tab resource, so it freezes the user's *other* tabs too), and
   * the autosave debounce re-armed so often that nothing was ever actually saved. Bailing out once the
   * document already holds this text costs nothing: identical text means the server has it.
   */
  restoreRecoveredContent(noteId: string, markdown: string): void {
    const note = this._notes().find((row) => row.id === noteId);
    if (note?.content === markdown) return;
    this.updateContent(noteId, markdown);
  }

  /** `11 Aug at 14:32` in the user's locale — a name you can place in time without opening the page. */
  private defaultTitle(): string {
    const now = new Date();
    const day = now.toLocaleDateString(undefined, { day: "numeric", month: "short" });
    const time = now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return `${day} at ${time}`;
  }

  async deleteNote(noteId: string): Promise<void> {
    // Cancel any queued save first: a PATCH landing after the DELETE would 404 and flip the
    // indicator to "error" for a page the user has already discarded.
    this.cancelPending(noteId);
    const snapshot = this._notes();
    this._notes.update((notes) => notes.filter((note) => note.id !== noteId));
    this.forget(noteId);
    if (this.activeNoteId() === noteId) this.selectNeighbour(snapshot, noteId);
    try {
      await this.api.delete(`/scratchpad/notes/${noteId}`);
    } catch {
      this._notes.set(snapshot);
      this.saveState.set("error");
    }
  }

  /**
   * Reorder a tab. Optimistic, then reconciled by the server's authoritative position.
   *
   * `beforeNoteId: null` means "last" — the same anchor vocabulary the notes and card routes use.
   */
  async moveNote(noteId: string, anchor: { afterNoteId?: string | null; beforeNoteId?: string | null }): Promise<void> {
    const snapshot = this._notes();
    this.applyOptimisticMove(noteId, anchor);
    try {
      const moved = await this.api.patch<{ id: string; position: string }>(
        `/scratchpad/notes/${noteId}/move`,
        anchor,
      );
      this._notes.update((notes) =>
        notes.map((note) => (note.id === moved.id ? { ...note, position: moved.position } : note)));
    } catch {
      this._notes.set(snapshot);
      this.saveState.set("error");
    }
  }

  /** Interpolate a local position so the tab strip settles before the round trip. */
  private applyOptimisticMove(noteId: string, anchor: { afterNoteId?: string | null; beforeNoteId?: string | null }): void {
    const ordered = this.notes().filter((note) => note.id !== noteId);
    const anchorIndex = anchor.afterNoteId
      ? ordered.findIndex((note) => note.id === anchor.afterNoteId) + 1
      : anchor.beforeNoteId
        ? ordered.findIndex((note) => note.id === anchor.beforeNoteId)
        : anchor.afterNoteId === null
          ? 0
          : ordered.length;
    if (anchorIndex < 0) return;
    const prev = anchorIndex > 0 ? Number(ordered[anchorIndex - 1]?.position ?? 0) : null;
    const next = anchorIndex < ordered.length ? Number(ordered[anchorIndex]?.position ?? 0) : null;
    const position = prev === null && next === null
      ? 1000
      : prev === null
        ? next! - 1000
        : next === null
          ? prev + 1000
          : (prev + next) / 2;
    this._notes.update((notes) =>
      notes.map((note) => (note.id === noteId ? { ...note, position: position.toFixed(10) } : note)));
  }

  // ── Autosave pipeline ──────────────────────────────────────────────────────

  /**
   * Coalesce a field change into one pending patch per note and (re)arm its debounce.
   *
   * Per-note rather than global so editing two pages in quick succession cannot make one page's save
   * cancel the other's.
   */
  private queueSave(noteId: string, patch: PendingPatch): void {
    this.pending.set(noteId, { ...this.pending.get(noteId), ...patch });
    // Deliberately does NOT touch `saveState`. Setting "saving" here put a spinning icon in the
    // header on every keystroke, which is exactly the fidgeting a writing surface must not do — the
    // indicator is owned by `sendPending`, and only once a request is genuinely slow.
    const existing = this.saveTimers.get(noteId);
    if (existing) clearTimeout(existing);
    this.saveTimers.set(noteId, setTimeout(() => {
      this.saveTimers.delete(noteId);
      void this.sendPending(noteId);
    }, AUTOSAVE_DEBOUNCE_MS));
  }

  /**
   * Send every pending patch now. Used at each boundary where text could otherwise be lost.
   *
   * Iterates `pending` rather than `saveTimers`, so it also picks up a patch left over by a failed
   * save — that one has no timer, and flushing is the retry path for it.
   */
  flushAll(): void {
    for (const timer of this.saveTimers.values()) clearTimeout(timer);
    this.saveTimers.clear();
    for (const noteId of [...this.pending.keys()]) void this.sendPending(noteId);
  }

  private cancelPending(noteId: string): void {
    const timer = this.saveTimers.get(noteId);
    if (timer) clearTimeout(timer);
    this.saveTimers.delete(noteId);
    this.pending.delete(noteId);
  }

  /**
   * One in-flight PATCH per note, never two.
   *
   * Overlapping saves would let responses come back out of order, and the response `updatedAt` is the
   * echo watermark — a stale one landing last would leave the watermark *behind* the server's real
   * state, so the next genuine remote edit would be mistaken for our own echo and silently dropped.
   * Edits that arrive mid-flight stay in `pending` and are re-sent from the ack below.
   */
  private async sendPending(noteId: string): Promise<void> {
    const patch = this.pending.get(noteId);
    if (!patch || Object.keys(patch).length === 0) return;
    if (this.inFlight.has(noteId)) return;
    this.pending.delete(noteId);
    this.inFlight.set(noteId, patch);
    this.armSavingIndicator();
    const lifecycleVersion = this.lifecycleVersion;
    let succeeded = false;
    try {
      const saved = await this.api.patch<WireScratchpadNote>(`/scratchpad/notes/${noteId}`, patch);
      if (lifecycleVersion !== this.lifecycleVersion) return;
      this.acknowledge(saved, patch);
      succeeded = true;
    } catch {
      if (lifecycleVersion !== this.lifecycleVersion) return;
      // Put the patch back so the next flush retries it, under anything typed since so newer text
      // wins. The local document is untouched and the draft layer still holds it, so a failed request
      // never costs the user a keystroke.
      this.pending.set(noteId, { ...patch, ...this.pending.get(noteId) });
      this.saveState.set("error");
    } finally {
      if (lifecycleVersion === this.lifecycleVersion) {
        // Cleared BEFORE the two calls below, both of which ask whether anything is still outstanding.
        // With this left until after them, `flashSaved` would always see itself in flight and "Saved"
        // would never appear.
        this.inFlight.delete(noteId);
        this.disarmSavingIndicator();
        if (!succeeded) {
          // Deliberately no immediate retry: re-sending here would spin a tight loop against a network
          // that is down. The patch stays queued for the next keystroke or flush boundary.
        } else if (this.pending.has(noteId)) {
          // An edit that arrived mid-flight has already waited out a full round trip, so it goes now
          // rather than being re-debounced.
          void this.sendPending(noteId);
        } else {
          this.flashSaved();
        }
      }
    }
  }

  /**
   * Fold an accepted save into local state.
   *
   * Order matters. The watermark advances first, so an echo of *this* write that is already on the
   * wire is recognised. `markClean` is then called with exactly the markdown that was saved — not the
   * editor's current text — so text typed during the flight still reads as dirty and gets saved next.
   */
  private acknowledge(saved: WireScratchpadNote, patch: PendingPatch): void {
    this.lastSavedAt.set(saved.id, this.timestamp(saved.updatedAt));
    // Metadata from the server, body from the patch we sent: `saved.content` is the same text with
    // media URLs re-signed, and adopting it would not match what the editor holds.
    this._notes.update((notes) => notes.map((note) => (note.id === saved.id
      ? { ...note, title: saved.title, position: saved.position, updatedAt: saved.updatedAt }
      : note)));
    if (patch.content === undefined) return;
    this.lastAckedContent.set(saved.id, patch.content);
    if (this.editor?.noteId === saved.id) this.editor.markClean(patch.content);
    // Re-saving the draft with the acked text as its base clears it (EditorDrafts drops a draft that
    // matches its baseline), so recovery only ever holds genuinely unsaved work.
    this.syncDraft(saved.id, this.editor?.noteId === saved.id ? this.editor.currentMarkdown() : patch.content);
  }

  /**
   * Start the clock on the spinner. Only fires if the request is still outstanding when it expires,
   * so a normal save never shows one — and the "error" label is never overwritten by a later,
   * unrelated attempt starting up.
   */
  private armSavingIndicator(): void {
    if (this.savingIndicatorTimer) return;
    this.savingIndicatorTimer = setTimeout(() => {
      this.savingIndicatorTimer = null;
      if (this.inFlight.size > 0) this.saveState.set("saving");
    }, SAVING_INDICATOR_DELAY_MS);
  }

  private disarmSavingIndicator(): void {
    if (this.inFlight.size > 0) return;
    if (this.savingIndicatorTimer) clearTimeout(this.savingIndicatorTimer);
    this.savingIndicatorTimer = null;
  }

  private flashSaved(): void {
    if (this.saveTimers.size > 0 || this.inFlight.size > 0) return;
    this.saveState.set("saved");
    if (this.savedFlashTimer) clearTimeout(this.savedFlashTimer);
    this.savedFlashTimer = setTimeout(() => {
      this.savedFlashTimer = null;
      if (this.saveState() === "saved") this.saveState.set("idle");
    }, SAVED_FLASH_MS);
  }

  // ── Drafts ─────────────────────────────────────────────────────────────────

  private syncDraft(noteId: string, markdown: string): void {
    this.drafts.save({
      userId: this.auth.user()?.id,
      kind: "scratchpad-note",
      entityId: noteId,
      markdown,
      baseMarkdown: this.lastAckedContent.get(noteId) ?? "",
    });
  }

  /**
   * Text this browser never got onto the server — a crash mid-edit, or the losing side of a
   * two-device collision. Offered as the editor's starting content when it is newer than the server's
   * copy, which is the only case where preferring local text cannot discard a remote edit.
   */
  recoveredMarkdown(note: WireScratchpadNote): string | null {
    const draft = this.drafts.load(this.auth.user()?.id, "scratchpad-note", note.id);
    if (!draft) return null;
    return this.timestamp(draft.updatedAt) > this.timestamp(note.updatedAt) ? draft.markdown : null;
  }

  private forget(noteId: string): void {
    this.drafts.clear(this.auth.user()?.id, "scratchpad-note", noteId);
    this.lastSavedAt.delete(noteId);
    this.lastAckedContent.delete(noteId);
  }

  // ── Realtime ───────────────────────────────────────────────────────────────

  private attachSocket(): void {
    const socket = this.sockets.connect();
    const handlers: Partial<ServerToClientEvents> = {
      [SERVER_EVENTS.SCRATCHPAD_NOTE_CREATED]: ({ note }) => this.upsert(note),

      /**
       * The three-way echo rule. Every branch here exists because of a specific way this can go wrong.
       *
       * 1. `updatedAt <= lastSavedAt` — this is our OWN save coming back. The text is already in the
       *    editor; touching the document would reset the cursor and eat whatever was typed since.
       *    List metadata is still refreshed, because that is cheap and always correct.
       * 2. Newer, and the editor is clean — a genuine edit from the user's other device. Safe to adopt
       *    wholesale, and the watermark advances so this note's own echo is recognised next time.
       * 3. Newer, but the editor is dirty or has a queued/in-flight body write — both sides have text.
       *    Local wins: the pending autosave will overwrite the server (last-write-wins by design), and
       *    silently replacing what someone is actively typing is the worse failure. The explicit body
       *    check matters for trailing blank paragraphs: TipTap omits them from serialized Markdown, so
       *    the semantic dirty check can be false even though replacing the document would move the
       *    live cursor. The overwritten remote text is still in that device's own draft store.
       */
      [SERVER_EVENTS.SCRATCHPAD_NOTE_UPDATED]: ({ note }) => {
        const isOwnEcho = this.timestamp(note.updatedAt) <= (this.lastSavedAt.get(note.id) ?? 0);
        const isActiveEditor = this.editor?.noteId === note.id;
        const hasLocalBodyWrite = this.pending.get(note.id)?.content !== undefined
          || this.inFlight.get(note.id)?.content !== undefined;

        if (isOwnEcho) {
          this.mergeMetadata(note);
          return;
        }
        if (!isActiveEditor) {
          // No editor mounted for this page, so there is nothing to clobber — adopt it entirely.
          this.upsert(note);
          this.lastSavedAt.set(note.id, this.timestamp(note.updatedAt));
          this.lastAckedContent.set(note.id, note.content);
          return;
        }
        if (hasLocalBodyWrite || this.editor!.isDirty()) {
          this.mergeMetadata(note);
          return;
        }
        this.upsert(note);
        this.lastSavedAt.set(note.id, this.timestamp(note.updatedAt));
        this.lastAckedContent.set(note.id, note.content);
        this.editor!.replaceWithCleanMarkdown(note.content);
      },

      [SERVER_EVENTS.SCRATCHPAD_NOTE_MOVED]: ({ noteId, position }) => {
        this._notes.update((notes) =>
          notes.map((note) => (note.id === noteId ? { ...note, position } : note)));
      },

      // Emitted before `moved` by the server, so applying it in arrival order is correct: the moved
      // page's own position then arrives against already-renumbered neighbours.
      [SERVER_EVENTS.SCRATCHPAD_NOTE_REBALANCED]: ({ positions }) => {
        const byId = new Map(positions.map((row) => [row.id, row.position]));
        this._notes.update((notes) =>
          notes.map((note) => (byId.has(note.id) ? { ...note, position: byId.get(note.id)! } : note)));
      },

      [SERVER_EVENTS.SCRATCHPAD_NOTE_DELETED]: ({ noteId }) => {
        const snapshot = this._notes();
        if (!snapshot.some((note) => note.id === noteId)) return;
        this.cancelPending(noteId);
        this._notes.update((notes) => notes.filter((note) => note.id !== noteId));
        this.forget(noteId);
        if (this.activeNoteId() === noteId) this.selectNeighbour(snapshot, noteId);
      },
    };
    const detachHandlers = registerSocketHandlers(socket, handlers);
    socket.on("connect", this.onSocketConnect);
    this.detach = () => {
      detachHandlers();
      socket.off("connect", this.onSocketConnect);
    };
  }

  private readonly onSocketConnect = () => {
    if (!this.initialised()) return;
    void this.refresh();
  };

  private upsert(note: WireScratchpadNote): void {
    this._notes.update((notes) =>
      notes.some((existing) => existing.id === note.id)
        ? notes.map((existing) => (existing.id === note.id ? note : existing))
        : [...notes, note]);
    this.ensureActiveNote();
  }

  /** Everything except the body — used when the body on screen must not be disturbed. */
  private mergeMetadata(note: WireScratchpadNote): void {
    this._notes.update((notes) => notes.map((existing) => (existing.id === note.id
      ? { ...existing, title: note.title, position: note.position, updatedAt: note.updatedAt }
      : existing)));
  }

  /** After the active page disappears, land on the closest surviving tab rather than on nothing. */
  private selectNeighbour(previous: WireScratchpadNote[], removedId: string): void {
    const ordered = [...previous].sort((a, b) => Number(a.position) - Number(b.position));
    const index = ordered.findIndex((note) => note.id === removedId);
    const neighbour = ordered[index + 1] ?? ordered[index - 1] ?? null;
    this.setActiveNote(neighbour?.id ?? null);
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  private activeKey(): string | null {
    const userId = this.auth.user()?.id;
    return userId ? scratchpadActiveNoteKey(userId) : null;
  }

  private restoreActiveNoteId(): void {
    const key = this.activeKey();
    if (!key || this.activeNoteId()) return;
    try {
      const stored = typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
      if (stored) this.activeNoteId.set(stored);
    } catch {
      // Private-mode storage; the panel just opens on the first page.
    }
  }

  private readOpen(): boolean {
    try {
      return typeof localStorage !== "undefined" && localStorage.getItem(STORAGE_KEYS.SCRATCHPAD_OPEN) === "1";
    } catch {
      return false;
    }
  }

  private readWidth(): number {
    try {
      const stored = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEYS.SCRATCHPAD_WIDTH) : null;
      return this.clampWidth(Number(stored));
    } catch {
      return SCRATCHPAD_DEFAULT_WIDTH;
    }
  }

  private clampWidth(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return SCRATCHPAD_DEFAULT_WIDTH;
    return Math.min(SCRATCHPAD_MAX_WIDTH, Math.max(SCRATCHPAD_MIN_WIDTH, Math.round(value)));
  }

  private readSheetHeight(): number {
    try {
      const stored = typeof localStorage !== "undefined"
        ? localStorage.getItem(STORAGE_KEYS.SCRATCHPAD_SHEET_HEIGHT)
        : null;
      return this.clampSheetHeight(Number(stored));
    } catch {
      return this.defaultSheetHeight();
    }
  }

  /**
   * Stored in pixels but clamped against the *current* viewport, so a height dragged on a tablet
   * cannot come back as a full-screen sheet on a phone, or as a sliver after a rotation.
   */
  private clampSheetHeight(value: number): number {
    const ceiling = Math.max(SCRATCHPAD_MIN_SHEET_HEIGHT, this.viewportHeight() - SHEET_VIEWPORT_RESERVE);
    if (!Number.isFinite(value) || value <= 0) return Math.min(ceiling, this.defaultSheetHeight());
    return Math.min(ceiling, Math.max(SCRATCHPAD_MIN_SHEET_HEIGHT, Math.round(value)));
  }

  /** Half the page, per the sheet's opening posture: enough to write in, enough to still see context. */
  private defaultSheetHeight(): number {
    return Math.max(SCRATCHPAD_MIN_SHEET_HEIGHT, Math.round(this.viewportHeight() * SHEET_DEFAULT_FRACTION));
  }

  private viewportHeight(): number {
    return typeof window !== "undefined" && window.innerHeight > 0 ? window.innerHeight : 800;
  }

  private writeStorage(key: string, value: string): void {
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
    } catch {
      // Panel geometry is a convenience; storage failures must not break writing.
    }
  }

  /** Wire timestamps arrive as ISO strings but are typed `Date | string`. */
  private timestamp(value: Date | string): number {
    return new Date(value).getTime();
  }
}
