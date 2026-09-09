import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  type OnDestroy,
  output,
  signal,
  untracked,
  ViewChild,
} from "@angular/core";
import { Router } from "@angular/router";
import type { WireScratchpadNote } from "@kanera/shared/events";
import type { AnchoredPanelPlacement } from "../../shared/anchored-panel";
import { AnchoredPanelDirective } from "../../shared/anchored-panel.directive";
import { ToastService } from "../../shared/toast.service";
import { EmptyStateComponent } from "../../shared/empty-state.component";
import { MenuDirective } from "../../shared/menu.directive";
import { LogoComponent } from "../../shared/logo.component";
import { TooltipDirective } from "../../shared/tooltip.directive";
import { DescriptionEditorComponent } from "../board/description-editor.component";
import {
  MAX_SCRATCHPAD_NOTES,
  SCRATCHPAD_MAX_WIDTH,
  SCRATCHPAD_MIN_SHEET_HEIGHT,
  SCRATCHPAD_MIN_WIDTH,
  ScratchpadService,
} from "./scratchpad.service";
import { formatDateTime } from "../../shared/date-format";

/** Below this the dock has no room to be a dock and becomes a bottom sheet. Matches the shell's
 * auto-collapse breakpoint, so the sidebar and the scratchpad change shape at the same width. */
const SHEET_QUERY = "(max-width: 900px)";
/** The popped-out route. Exported so the shell and the route table cannot drift from each other. */
export const SCRATCHPAD_ROUTE = "/scratchpad";
/** Named target so repeated pop-outs reuse one top-level window instead of opening duplicates. */
const SCRATCHPAD_POPOUT_TARGET = "kanera-scratchpad";

/**
 * Open the scratchpad in another top-level browsing context.
 *
 * Installed PWAs still support `window.open`; standalone display mode means an app window has no tab
 * strip, not that it cannot create another window. Keep display-mode detection out of this path so
 * the same direct user gesture works in both a browser tab and an installed app.
 */
export function openScratchpadPopoutWindow(url: string): Window | null {
  return window.open(url, SCRATCHPAD_POPOUT_TARGET);
}

/**
 * The scratchpad: a private, autosaving notepad docked to the right of the app shell.
 *
 * Deliberately NOT modal, which is the whole point and the one thing that must not regress. There is
 * no backdrop, no focus trap, no body scroll lock, and no PanelStack registration — the value of this
 * panel is writing notes *while reading a board*, so the page underneath stays fully interactive and
 * keeps its own Escape handling. (The notifications and Up-next drawers are modal because they are
 * things you glance at and dismiss; this is a thing you work in.)
 *
 * On desktop it is a real grid column in the shell rather than a floating overlay, so the board simply
 * has less room instead of being covered. Below 900px there is no room for a third column, so it
 * becomes a bottom sheet.
 *
 * `variant="page"` is the popped-out form: the same component filling its own window or tab (see
 * `ScratchpadPage`). One component rather than two, because everything that makes this hard to get
 * right — the autosave bridge, the rename field, crash recovery — must
 * behave identically in both forms, and a second implementation would only diverge from this one.
 */
@Component({
  selector: "k-scratchpad-panel",
  standalone: true,
  imports: [AnchoredPanelDirective, DescriptionEditorComponent, EmptyStateComponent, LogoComponent, MenuDirective, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./scratchpad-panel.component.html",
  styleUrl: "./scratchpad-panel.component.scss",
  host: {
    // Sheet and page are mutually exclusive shapes: a popped-out tab on a narrow phone is a full page,
    // never a bottom sheet floating over nothing.
    "[class.sheet]": "isSheetForm()",
    "[class.as-page]": "isPage()",
    "[class.is-open]": "visible()",
  },
})
export class ScratchpadPanelComponent implements OnDestroy {
  protected readonly scratchpad = inject(ScratchpadService);
  private readonly toasts = inject(ToastService);
  private readonly router = inject(Router);

  /**
   * `dock` is the shell's right-hand column; `page` is the popped-out tab, where the panel *is* the
   * document and the shell's open/closed flag no longer applies to it.
   */
  readonly variant = input<"dock" | "page">("dock");
  /** Lets the shell suspend its grid transition while the dock is following a live pointer drag. */
  readonly resizeStateChange = output<boolean>();
  protected readonly isPage = computed(() => this.variant() === "page");
  /**
   * Whether the panel is on screen and owns an editor. The popped-out page is always on screen — it has
   * nothing to be hidden behind — so it must not read the dock's open flag, which the pop-out gesture
   * deliberately sets to false.
   */
  protected readonly visible = computed(() => this.isPage() || this.scratchpad.open());

  protected readonly notes = this.scratchpad.notes;
  protected readonly activeNote = this.scratchpad.activeNote;
  protected readonly open = this.scratchpad.open;
  /**
   * True when the shell renders this panel's trigger in its sidebar utility row. The panel then
   * paints no fixed button of its own; the shell calls toggle() directly.
   */
  readonly embedded = input(false);

  protected readonly saveState = this.scratchpad.saveState;
  protected readonly loading = this.scratchpad.loading;
  protected readonly loadError = this.scratchpad.loadError;
  protected readonly atCapacity = this.scratchpad.atCapacity;
  protected readonly maxNotes = MAX_SCRATCHPAD_NOTES;

  protected readonly isSheet = signal(this.matchesSheet());
  /** The bottom-sheet shape: narrow viewport *and* docked. A popped-out tab is a page at any width. */
  protected readonly isSheetForm = computed(() => this.isSheet() && !this.isPage());
  /** Whether the active page's name in the header is being edited inline. */
  protected readonly renamingId = signal<string | null>(null);
  /**
   * The panel menu (`…`): actions on the current page plus the panel-level ones. Anchored to the
   * button it opened from so kAnchoredPanel can place it against the live rect.
   */
  private readonly panelMenuAnchor = signal<HTMLElement | null>(null);
  protected readonly panelMenu = computed(() => {
    const anchor = this.panelMenuAnchor();
    return anchor ? { anchor, note: this.activeNote() } : null;
  });
  protected readonly panelMenuPlacement: AnchoredPanelPlacement = {
    side: "bottom",
    align: "end",
    // Sized from its own CSS so the width follows the labels. See `.panel-menu`.
    width: "measure",
    maxHeight: 320,
    minHeight: 160,
    gap: 4,
    margin: 6,
  };
  /**
   * The page list, opened from the page name in the header. Replaces the old horizontal tab strip: a
   * vertical list scales to the fifty-page cap, shows every name in full, and needs no drag code.
   */
  private readonly pageListAnchor = signal<HTMLElement | null>(null);
  protected readonly pageList = computed(() => {
    const anchor = this.pageListAnchor();
    return anchor ? { anchor } : null;
  });
  protected readonly pageQuery = signal("");
  /** Search only earns its row once the list is long enough to need it. */
  protected readonly showPageSearch = computed(() => this.notes().length > 5);
  protected readonly filteredPages = computed(() => {
    const query = this.pageQuery().trim().toLocaleLowerCase();
    if (!query) return this.notes();
    return this.notes().filter((note) => this.tabLabel(note).toLocaleLowerCase().includes(query));
  });
  protected readonly pageListPlacement: AnchoredPanelPlacement = {
    side: "bottom",
    align: "start",
    width: 300,
    maxHeight: 400,
    minHeight: 120,
    gap: 4,
    margin: 6,
  };
  protected readonly resizing = signal(false);

  protected readonly showEmptyState = computed(() =>
    !this.loading() && !this.loadError() && this.notes().length === 0,
  );
  protected readonly showInitialLoading = computed(() => this.loading() && this.notes().length === 0);

  /**
   * What the editor mounts with, resolved once per page rather than per keystroke.
   *
   * `DescriptionEditorComponent` reads `value` only when it initialises, so this has to be stable for
   * the life of one mounted editor — and it must not be a computed over the note's `content`, or every
   * keystroke would re-read the draft store from localStorage looking for a recovery that cannot have
   * appeared. `seedList` exists purely to give the template something to key on: `@for` with
   * `track noteId` is what forces a fresh editor (and a fresh undo stack) per page.
   */
  protected readonly editorSeed = signal<{ noteId: string; value: string; baseline: string | null } | null>(null);
  /**
   * Which page the editor should be seeded from, as a plain id — the dependency the re-seed effect
   * below is allowed to have.
   *
   * Deliberately NOT `activeNote()?.id`. `activeNote` is a computed over the notes array, so it hands
   * back a *new object* on every keystroke, and an effect reading it re-runs on every keystroke even
   * though the page never changed. That is what made the re-seed effect re-entrant: it hands recovered
   * text to the service, the service mutates the notes array, the effect runs again, for ever. A
   * computed that resolves to a string settles on value equality, so it notifies only when the page
   * genuinely changes — or when a remembered page first arrives in the list, which is the other moment
   * a seed is owed.
   */
  private readonly seedNoteId = computed(() => {
    // Closing unmounts the editor while the deferred panel survives. Clear its seed so reopening
    // starts from the latest saved/draft text instead of the content from the first open.
    if (!this.visible()) return null;
    const id = this.scratchpad.activeNoteId();
    return id && this.notes().some((note) => note.id === id) ? id : null;
  });
  protected readonly seedList = computed(() => {
    const seed = this.editorSeed();
    return seed ? [seed] : [];
  });

  @ViewChild(DescriptionEditorComponent) private editorComponent?: DescriptionEditorComponent;


  private resizePointerId: number | null = null;
  private resizeStartX = 0;
  private resizeStartWidth = 0;
  private sheetPointerId: number | null = null;
  private sheetStartY = 0;
  private sheetStartHeight = 0;
  private readonly onSheetChange = (event: MediaQueryListEvent) => this.isSheet.set(event.matches);
  private sheetQueryList: MediaQueryList | null = null;

  constructor() {
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      this.sheetQueryList = window.matchMedia(SHEET_QUERY);
      this.sheetQueryList.addEventListener("change", this.onSheetChange);
    }
    // The panel can be opened before it has ever loaded (restored from localStorage at startup, or
    // the shell shortcut), so kick the lazy first fetch from here rather than from a click handler.
    effect(() => {
      if (this.visible()) this.scratchpad.initialise();
    });
    // Re-seed only when the *page* changes — see `seedNoteId`, which is what makes that true. Both the
    // stable dependency and the `untracked` block matter: reading the note body tracked would remount
    // the editor mid-word, and reading the note *object* would re-run this on every keystroke.
    effect(() => {
      const noteId = this.seedNoteId();
      if (!noteId) {
        this.editorSeed.set(null);
        return;
      }
      untracked(() => {
        const note = this.notes().find((candidate) => candidate.id === noteId);
        if (!note) return;
        const recovered = this.scratchpad.recoveredMarkdown(note);
        if (recovered !== null) this.scratchpad.restoreRecoveredContent(note.id, recovered);
        this.editorSeed.set({
          noteId,
          value: recovered ?? note.content,
          // Non-null tells the editor it opened on unsaved work, so it starts dirty (and keeps the
          // leave-the-page prompt armed) instead of pretending the recovered text is saved.
          baseline: recovered === null ? null : note.content,
        });
      });
    });
    // Hand the service a bridge to whichever editor is mounted. Keyed by note id so an echo can never
    // be applied to the wrong page's document after a fast tab switch.
    effect(() => {
      const note = this.activeNote();
      const editor = this.editorComponent;
      if (!note || !editor || !this.visible()) {
        this.scratchpad.registerEditor(null);
        return;
      }
      this.scratchpad.registerEditor({
        noteId: note.id,
        markClean: (markdown) => editor.markClean(markdown),
        replaceWithCleanMarkdown: (markdown) => editor.replaceWithCleanMarkdown(markdown),
        isDirty: () => editor.isDirty(),
        currentMarkdown: () => editor.markdown(),
      });
    });
  }

  ngOnDestroy(): void {
    this.sheetQueryList?.removeEventListener("change", this.onSheetChange);
    // Never leave text in a debounce that is about to be discarded with the component.
    this.scratchpad.flushAll();
    this.scratchpad.registerEditor(null);
    // Hiding the personal scratchpad removes this dock component. Close its remembered UI state as
    // well, otherwise showing the control again later would unexpectedly reopen the panel.
    if (!this.isPage()) this.scratchpad.setOpen(false);
  }

  protected close(): void {
    this.scratchpad.setOpen(false);
  }

  protected toggle(): void {
    this.scratchpad.toggle();
  }

  /**
   * Move the scratchpad into its own window or browser tab and close the dock behind it.
   *
   * The two halves are one gesture and must not half-happen: the new tab loads its pages from the
   * server, and the dock's editor is about to be destroyed, so anything still sitting in the autosave
   * debounce is flushed before either. The dock is closed only once there is somewhere for the writing
   * to continue — a blocked popup must never end with the panel gone and no page in its place.
   *
   * A stable window name means pressing this twice focuses the context that is already open rather
   * than stacking duplicates of the same notepad.
   */
  protected popOut(): void {
    this.scratchpad.flushAll();
    this.closePanelMenu();
    this.closePageList();
    this.renamingId.set(null);
    const url = this.router.serializeUrl(this.router.createUrlTree([SCRATCHPAD_ROUTE]));
    const popped = openScratchpadPopoutWindow(url);
    this.scratchpad.setOpen(false);
    if (popped) {
      popped.focus();
      // Only the dock closes. The page it was docked beside is left exactly as it was, which is the
      // whole point of popping out instead of navigating.
      return;
    }
    // The popup was blocked. Navigating this context reaches the same end state — the scratchpad
    // filling the window — and Back undoes it.
    void this.router.navigateByUrl(url);
  }

  /**
   * The inverse gesture, offered only by the popped-out page: give the dock back and get out of the way.
   *
   * `requestDock` writes the shared open flag, which is what raises the `storage` event that re-opens
   * the dock in the tab this page was popped out of. Closing is only permitted for a window that script
   * opened — which is exactly what `window.opener` tells us — so a page reached any other way (a
   * bookmark, the in-place fallback above) walks itself back into the app instead.
   */
  protected dockBack(): void {
    this.scratchpad.flushAll();
    this.scratchpad.requestDock();
    if (window.opener) {
      window.close();
      return;
    }
    void this.router.navigateByUrl("/");
  }

  protected selectNote(noteId: string): void {
    this.closePanelMenu();
    this.closePageList();
    this.renamingId.set(null);
    this.scratchpad.setActiveNote(noteId);
  }

  protected async addNote(): Promise<void> {
    if (this.atCapacity()) return;
    const note = await this.scratchpad.createNote();
    // Land straight in rename so a new page gets a name while the intent is fresh. Leaving it blank is
    // fine too: the first thing typed into the page names it after the time (see `updateContent`).
    if (note) this.startRename(note.id);
  }

  protected onContentChange(markdown: string): void {
    const note = this.activeNote();
    if (!note) return;
    this.scratchpad.updateContent(note.id, markdown);
  }

  // ── Renaming ───────────────────────────────────────────────────────────────

  protected startRename(noteId: string, event?: Event): void {
    event?.stopPropagation();
    this.closePanelMenu();
    this.closePageList();
    this.renamingId.set(noteId);
    this.focusRenameInput();
  }

  /**
   * Focus and select the rename field once it exists. `autofocus` is unreliable on an element inserted
   * after page load, and pre-selecting matters: a page auto-named after its timestamp should be
   * replaceable by typing, not something to clear first.
   */
  private focusRenameInput(): void {
    requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>(".page-rename");
      if (!input) return;
      input.focus();
      input.select();
    });
  }

  protected onRenameInput(noteId: string, value: string): void {
    this.scratchpad.renameNote(noteId, value);
  }

  protected commitRename(): void {
    this.renamingId.set(null);
    // Flush rather than wait out the debounce: the input is gone, so there is no longer anything on
    // screen explaining why the title has not settled.
    this.scratchpad.flushAll();
  }

  protected onRenameKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" || event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.commitRename();
    }
  }

  // ── Panel menu ─────────────────────────────────────────────────────────────

  protected togglePanelMenu(event: Event): void {
    event.stopPropagation();
    this.closePageList();
    const open = this.panelMenuAnchor() !== null;
    this.panelMenuAnchor.set(open ? null : (event.currentTarget as HTMLElement));
  }

  protected closePanelMenu(): void {
    this.panelMenuAnchor.set(null);
  }

  // ── Page list ──────────────────────────────────────────────────────────────

  protected togglePageList(event: Event): void {
    event.stopPropagation();
    this.closePanelMenu();
    const open = this.pageListAnchor() !== null;
    this.pageListAnchor.set(open ? null : (event.currentTarget as HTMLElement));
    this.pageQuery.set("");
    if (!open && this.showPageSearch()) {
      requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".page-list-search")?.focus());
    }
  }

  protected closePageList(): void {
    this.pageListAnchor.set(null);
    this.pageQuery.set("");
  }

  protected selectPageFromList(noteId: string): void {
    this.selectNote(noteId);
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(".page-trigger")?.focus());
  }

  /**
   * The search field sits inside a kMenu, whose typeahead would otherwise steal every letter typed
   * into it. Letters stay in the field; only the arrows and Enter are handed to the list.
   */
  protected onPageSearchKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter") {
      const first = this.filteredPages()[0];
      if (!first) return;
      event.preventDefault();
      this.selectPageFromList(first.id);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      document.querySelector<HTMLButtonElement>(".page-list-item")?.focus();
      return;
    }
    if (event.key !== "Escape") event.stopPropagation();
  }

  protected async removeNote(note: WireScratchpadNote, event?: Event): Promise<void> {
    event?.stopPropagation();
    this.closePanelMenu();
    const label = note.title.trim() || "Untitled";
    // Undo instead of confirm: the page disappears at once and the DELETE waits for the toast.
    const { restore, commit } = this.scratchpad.hideNote(note.id);
    this.toasts.undoable({ message: `Page "${label}" deleted.`, icon: "trash", undo: restore, commit });
  }

  /** Reorder from the panel menu (Move page up / down): reachable by pointer, touch and keyboard alike. */
  // ── Resize ─────────────────────────────────────────────────────────────────

  protected onResizePointerDown(event: PointerEvent): void {
    if (this.isSheetForm()) return;
    event.preventDefault();
    this.resizePointerId = event.pointerId;
    this.resizeStartX = event.clientX;
    this.resizeStartWidth = this.scratchpad.width();
    this.resizing.set(true);
    this.resizeStateChange.emit(true);
    // Pointer capture keeps the drag alive over the board, iframes, and the editor — without it the
    // handle loses the pointer the moment the cursor crosses into other content.
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  protected onResizePointerMove(event: PointerEvent): void {
    if (this.resizePointerId !== event.pointerId) return;
    // Dragging left widens: the handle is on the panel's left edge.
    this.scratchpad.setWidth(this.resizeStartWidth + (this.resizeStartX - event.clientX));
  }

  protected onResizePointerUp(event: PointerEvent): void {
    if (this.resizePointerId !== event.pointerId) return;
    this.resizePointerId = null;
    this.resizing.set(false);
    this.resizeStateChange.emit(false);
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
    this.scratchpad.persistWidth();
  }

  /** Keyboard resize, so the width is not mouse-only. */
  protected onResizeKeydown(event: KeyboardEvent): void {
    const step = event.shiftKey ? 40 : 16;
    if (event.key === "ArrowLeft") this.scratchpad.setWidth(this.scratchpad.width() + step);
    else if (event.key === "ArrowRight") this.scratchpad.setWidth(this.scratchpad.width() - step);
    else return;
    event.preventDefault();
    this.scratchpad.persistWidth();
  }

  /**
   * Sheet resize: the grip is the handle, dragged vertically.
   *
   * The sheet has an explicit height rather than sizing to its content, which is what stops switching
   * pages from resizing the sheet under the user's thumb — a short page and a long one must not make
   * the panel jump. That height is the user's, so it has to be draggable here and remembered.
   */
  protected onSheetResizePointerDown(event: PointerEvent): void {
    if (!this.isSheetForm()) return;
    event.preventDefault();
    this.sheetPointerId = event.pointerId;
    this.sheetStartY = event.clientY;
    this.sheetStartHeight = this.scratchpad.sheetHeight();
    this.resizing.set(true);
    this.resizeStateChange.emit(true);
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  protected onSheetResizePointerMove(event: PointerEvent): void {
    if (this.sheetPointerId !== event.pointerId) return;
    // Dragging up grows the sheet: the handle is on its top edge.
    this.scratchpad.setSheetHeight(this.sheetStartHeight + (this.sheetStartY - event.clientY));
  }

  protected onSheetResizePointerUp(event: PointerEvent): void {
    if (this.sheetPointerId !== event.pointerId) return;
    this.sheetPointerId = null;
    this.resizing.set(false);
    this.resizeStateChange.emit(false);
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
    this.scratchpad.persistSheetHeight();
  }

  protected onSheetResizeKeydown(event: KeyboardEvent): void {
    const step = event.shiftKey ? 80 : 32;
    if (event.key === "ArrowUp") this.scratchpad.setSheetHeight(this.scratchpad.sheetHeight() + step);
    else if (event.key === "ArrowDown") this.scratchpad.setSheetHeight(this.scratchpad.sheetHeight() - step);
    else return;
    event.preventDefault();
    this.scratchpad.persistSheetHeight();
  }

  protected readonly minWidth = SCRATCHPAD_MIN_WIDTH;
  protected readonly maxWidth = SCRATCHPAD_MAX_WIDTH;
  protected readonly minSheetHeight = SCRATCHPAD_MIN_SHEET_HEIGHT;
  /** Only applied in sheet mode; the dock takes its height from the shell grid row and the page the tab. */
  protected readonly sheetHeightPx = computed(() => (this.isSheetForm() ? this.scratchpad.sheetHeight() : null));

  protected tabLabel(note: WireScratchpadNote): string {
    return note.title.trim() || "Untitled";
  }

  /** `Created 3 Mar · Updated 10:42` — the page list row's tooltip: created-at is worth having, not
   * worth a column. */
  protected metaLine(note: WireScratchpadNote): string {
    return `Created ${this.formatStamp(note.createdAt)} · Updated ${this.formatStamp(note.updatedAt)}`;
  }

  /** Just the time or date, for the page list where an "Updated" prefix on every row is noise. */
  protected stampLine(note: WireScratchpadNote): string {
    return this.formatStamp(note.updatedAt);
  }

  private formatStamp(value: Date | string): string {
    return formatDateTime(value, "compact") || "—";
  }

  private matchesSheet(): boolean {
    return typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia(SHEET_QUERY).matches;
  }
}
