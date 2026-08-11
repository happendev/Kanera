import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  type ElementRef,
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
import { ConfirmService } from "../../shared/confirm.service";
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
 * right — the autosave bridge, the rename field, tab reordering with edge scroll, crash recovery — must
 * behave identically in both forms, and a second implementation would only diverge from this one.
 */
@Component({
  selector: "k-scratchpad-panel",
  standalone: true,
  imports: [AnchoredPanelDirective, DescriptionEditorComponent, LogoComponent, TooltipDirective],
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
  private readonly confirm = inject(ConfirmService);
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
  protected readonly saveState = this.scratchpad.saveState;
  protected readonly loading = this.scratchpad.loading;
  protected readonly loadError = this.scratchpad.loadError;
  protected readonly atCapacity = this.scratchpad.atCapacity;
  protected readonly maxNotes = MAX_SCRATCHPAD_NOTES;

  protected readonly isSheet = signal(this.matchesSheet());
  /** The bottom-sheet shape: narrow viewport *and* docked. A popped-out tab is a page at any width. */
  protected readonly isSheetForm = computed(() => this.isSheet() && !this.isPage());
  /** Which tab is being renamed inline, if any. */
  protected readonly renamingId = signal<string | null>(null);
  /**
   * The open tab menu, holding the `…` button it is anchored to.
   *
   * An anchor element rather than just an id because the menu is rendered outside the scrolling tab
   * strip (see the template) and therefore has to be positioned against the button's live rect.
   */
  protected readonly menuOpenId = signal<string | null>(null);
  private readonly menuAnchor = signal<HTMLElement | null>(null);
  protected readonly menu = computed(() => {
    const id = this.menuOpenId();
    const anchor = this.menuAnchor();
    const note = this.notes().find((candidate) => candidate.id === id);
    return id && anchor && note ? { note, anchor } : null;
  });
  protected readonly menuPlacement: AnchoredPanelPlacement = {
    side: "bottom",
    align: "end",
    // The menu is four short rows; sizing from its own CSS keeps it the width of its labels instead of
    // a number here drifting away from them. See `.tab-menu`, which owns the width.
    width: "measure",
    maxHeight: 200,
    minHeight: 160,
    gap: 4,
    margin: 6,
  };
  private readonly pagePickerAnchor = signal<HTMLElement | null>(null);
  protected readonly pagePicker = computed(() => {
    const anchor = this.pagePickerAnchor();
    return anchor ? { anchor } : null;
  });
  protected readonly pageQuery = signal("");
  protected readonly filteredPages = computed(() => {
    const query = this.pageQuery().trim().toLocaleLowerCase();
    if (!query) return this.notes();
    return this.notes().filter((note) => this.tabLabel(note).toLocaleLowerCase().includes(query));
  });
  protected readonly pagePickerPlacement: AnchoredPanelPlacement = {
    side: "bottom",
    align: "start",
    width: 280,
    maxHeight: 360,
    minHeight: 120,
    gap: 4,
    margin: 6,
  };
  protected readonly resizing = signal(false);
  protected readonly draggingId = signal<string | null>(null);
  protected readonly dropTargetId = signal<string | null>(null);
  /** True when the drop indicator belongs after the hovered tab rather than before it. */
  protected readonly dropAfter = signal(false);

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
    const id = this.scratchpad.activeNoteId();
    return id && this.notes().some((note) => note.id === id) ? id : null;
  });
  protected readonly seedList = computed(() => {
    const seed = this.editorSeed();
    return seed ? [seed] : [];
  });

  @ViewChild(DescriptionEditorComponent) private editorComponent?: DescriptionEditorComponent;
  @ViewChild("tabStrip") private tabStrip?: ElementRef<HTMLElement>;

  /** How far the pointer must travel before a press on a tab becomes a reorder rather than a click. */
  private static readonly DRAG_INTENT_PX = 6;
  /** How close to an end of the strip a dragged tab starts scrolling it, and how fast at the very edge. */
  private static readonly EDGE_SCROLL_ZONE_PX = 56;
  private static readonly EDGE_SCROLL_MAX_PX = 16;

  private resizePointerId: number | null = null;
  private resizeStartX = 0;
  private resizeStartWidth = 0;
  private dragPointerId: number | null = null;
  private dragStartX = 0;
  private dragCandidateId: string | null = null;
  /** Latest pointer position during a tab drag, so the edge-scroll loop can hit-test without an event. */
  private pointerX = 0;
  private pointerY = 0;
  private edgeScrollFrame: number | null = null;
  /** Suppresses the synthetic click browsers dispatch after a completed pointer reorder. */
  private suppressTabClick = false;
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
      // The strip scrolls, so a page reached by any means other than clicking its own tab (restored
      // from storage, a neighbour after a delete, a remote create) could be selected while its tab is
      // out of view. Deferred a frame so the tab exists and has its final position.
      requestAnimationFrame(() => {
        document.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
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
    this.stopEdgeScroll();
    this.sheetQueryList?.removeEventListener("change", this.onSheetChange);
    // Never leave text in a debounce that is about to be discarded with the component.
    this.scratchpad.flushAll();
    this.scratchpad.registerEditor(null);
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
    this.closeMenu();
    this.closePagePicker();
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
    this.closeMenu();
    this.closePagePicker();
    this.renamingId.set(null);
    this.scratchpad.setActiveNote(noteId);
  }

  protected async addNote(): Promise<void> {
    if (this.atCapacity()) return;
    const note = await this.scratchpad.createNote();
    // Land straight in rename so a new tab gets a name while the intent is fresh. Leaving it blank is
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
    this.closeMenu();
    this.renamingId.set(noteId);
    this.focusRenameInput();
  }

  /**
   * Focus and select the rename field once it exists.
   *
   * `autofocus` is unreliable on an element inserted after page load, and pre-selecting matters here:
   * a page auto-named after its timestamp should be replaceable by typing, not something to clear
   * first. There is only ever one rename input in the strip, so a query is enough.
   */
  private focusRenameInput(): void {
    requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>(".tab-rename");
      if (!input) return;
      // The field is wider than the pill it replaced, so a tab near either end of a scrolled strip
      // has to be brought fully into view before it is focused.
      input.scrollIntoView({ block: "nearest", inline: "nearest" });
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

  // ── Tab menu ───────────────────────────────────────────────────────────────

  protected toggleMenu(noteId: string, event: Event): void {
    event.stopPropagation();
    this.closePagePicker();
    const open = this.menuOpenId() === noteId;
    this.menuAnchor.set(open ? null : (event.currentTarget as HTMLElement));
    this.menuOpenId.set(open ? null : noteId);
  }

  protected closeMenu(): void {
    this.menuOpenId.set(null);
    this.menuAnchor.set(null);
  }

  // ── Page switcher ─────────────────────────────────────────────────────────

  protected togglePagePicker(event: Event): void {
    event.stopPropagation();
    this.closeMenu();
    const open = this.pagePickerAnchor() !== null;
    this.pagePickerAnchor.set(open ? null : (event.currentTarget as HTMLElement));
    this.pageQuery.set("");
    if (!open) {
      requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".page-picker-search")?.focus());
    }
  }

  protected closePagePicker(): void {
    this.pagePickerAnchor.set(null);
    this.pageQuery.set("");
  }

  protected selectPageFromPicker(noteId: string): void {
    this.selectNote(noteId);
    requestAnimationFrame(() => this.focusTab(noteId));
  }

  protected onPagePickerSearchKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter") {
      const first = this.filteredPages()[0];
      if (!first) return;
      event.preventDefault();
      this.selectPageFromPicker(first.id);
      return;
    }
    if (event.key !== "ArrowDown") return;
    event.preventDefault();
    document.querySelector<HTMLButtonElement>(".page-picker-option")?.focus();
  }

  protected onPagePickerOptionKeydown(noteId: string, event: KeyboardEvent): void {
    const pages = this.filteredPages();
    const current = pages.findIndex((note) => note.id === noteId);
    if (current < 0) return;
    const nextIndex = event.key === "ArrowDown"
      ? Math.min(pages.length - 1, current + 1)
      : event.key === "ArrowUp"
        ? Math.max(0, current - 1)
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? pages.length - 1
            : -1;
    if (nextIndex < 0) return;
    event.preventDefault();
    document.getElementById(this.pageOptionId(pages[nextIndex]!.id))?.focus();
  }

  // ── Tab keyboard navigation ───────────────────────────────────────────────

  protected onTabClick(noteId: string, event: MouseEvent): void {
    if (this.suppressTabClick) {
      event.preventDefault();
      return;
    }
    this.selectNote(noteId);
  }

  protected onTabKeydown(noteId: string, event: KeyboardEvent): void {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const notes = this.notes();
    const current = notes.findIndex((note) => note.id === noteId);
    if (current < 0) return;
    const nextIndex = event.key === "ArrowRight"
      ? (current + 1) % notes.length
      : event.key === "ArrowLeft"
        ? (current - 1 + notes.length) % notes.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? notes.length - 1
            : -1;
    if (nextIndex < 0) return;
    event.preventDefault();
    const nextId = notes[nextIndex]!.id;
    this.selectNote(nextId);
    requestAnimationFrame(() => this.focusTab(nextId));
  }

  private focusTab(noteId: string): void {
    document.getElementById(this.tabId(noteId))?.focus();
  }

  protected async removeNote(note: WireScratchpadNote, event?: Event): Promise<void> {
    event?.stopPropagation();
    this.closeMenu();
    const label = note.title.trim() || "Untitled";
    const confirmed = await this.confirm.open({
      title: `Delete "${label}"?`,
      message: "This page and anything pasted into it will be deleted. This cannot be undone.",
      confirmLabel: "Delete page",
      danger: true,
    });
    if (!confirmed) return;
    await this.scratchpad.deleteNote(note.id);
  }

  // ── Tab reordering ─────────────────────────────────────────────────────────

  /**
   * Pointer-based drag, deliberately not the HTML5 `draggable` API.
   *
   * HTML5 drag-and-drop does not fire on touch at all, which would make tab order desktop-only —
   * unacceptable for a panel whose mobile form is a first-class bottom sheet. Pointer events give one
   * implementation for mouse, pen and touch, and match how the rest of the app drags things.
   *
   * A movement threshold separates a drag from a click, so tapping a tab still just selects it. The
   * `…` menu additionally offers Move left / Move right, which is the keyboard- and
   * screen-reader-reachable path to the same operation — dragging is never the only way.
   */
  protected onTabPointerDown(noteId: string, event: PointerEvent): void {
    // Left button / primary contact only, and never from the menu button or the rename input.
    if (event.button !== 0 || this.renamingId() === noteId) return;
    const target = event.target as HTMLElement;
    if (target.closest(".tab-menu-btn") || target.closest(".tab-menu")) return;
    this.dragPointerId = event.pointerId;
    this.dragStartX = event.clientX;
    this.dragCandidateId = noteId;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  protected onTabPointerMove(event: PointerEvent): void {
    if (this.dragPointerId !== event.pointerId || !this.dragCandidateId) return;
    if (!this.draggingId()) {
      if (Math.abs(event.clientX - this.dragStartX) < ScratchpadPanelComponent.DRAG_INTENT_PX) return;
      this.draggingId.set(this.dragCandidateId);
      this.startEdgeScroll();
    }
    this.pointerX = event.clientX;
    this.pointerY = event.clientY;
    this.updateDropTarget();
  }

  /**
   * Resolve what the pointer is over. Split out of the move handler because the edge-scroll loop has
   * to re-run it from a stationary pointer: the strip moves under the cursor, so the tab being
   * hovered changes with no pointer event to announce it.
   */
  private updateDropTarget(): void {
    // Pointer capture routes every move to the origin tab, so the tab under the cursor has to be
    // hit-tested rather than read from the event target.
    const element = document.elementFromPoint(this.pointerX, this.pointerY)?.closest<HTMLElement>(".tab");
    const overId = element?.dataset["noteId"];
    if (!overId || overId === this.draggingId()) {
      this.dropTargetId.set(null);
      return;
    }
    const rect = element!.getBoundingClientRect();
    this.dropTargetId.set(overId);
    // Past the midpoint means "after it", which is what lets a drag to the far end land last rather
    // than second-to-last.
    this.dropAfter.set(this.pointerX > rect.left + rect.width / 2);
  }

  /**
   * Scroll the strip while a tab is held near either end.
   *
   * Without this a reorder is capped at what fits on screen: with ten pages open, dragging the last
   * tab to the front is impossible, because the drop target has to be visible to be hit-tested and
   * the strip will not scroll itself while the pointer is captured. Speed ramps with how far into the
   * edge zone the pointer is, so a nudge creeps and a hard push moves.
   */
  private startEdgeScroll(): void {
    if (this.edgeScrollFrame !== null) return;
    const step = () => {
      const strip = this.tabStrip?.nativeElement;
      if (!strip || !this.draggingId()) {
        this.edgeScrollFrame = null;
        return;
      }
      const rect = strip.getBoundingClientRect();
      const zone = ScratchpadPanelComponent.EDGE_SCROLL_ZONE_PX;
      const max = ScratchpadPanelComponent.EDGE_SCROLL_MAX_PX;
      let delta = 0;
      if (this.pointerX < rect.left + zone) delta = -Math.ceil(((rect.left + zone - this.pointerX) / zone) * max);
      else if (this.pointerX > rect.right - zone) delta = Math.ceil(((this.pointerX - (rect.right - zone)) / zone) * max);
      if (delta !== 0) {
        const before = strip.scrollLeft;
        strip.scrollLeft += delta;
        // Only worth re-hit-testing if the strip actually moved; at either end it cannot.
        if (strip.scrollLeft !== before) this.updateDropTarget();
      }
      this.edgeScrollFrame = requestAnimationFrame(step);
    };
    this.edgeScrollFrame = requestAnimationFrame(step);
  }

  private stopEdgeScroll(): void {
    if (this.edgeScrollFrame !== null) cancelAnimationFrame(this.edgeScrollFrame);
    this.edgeScrollFrame = null;
  }

  protected async onTabPointerUp(event: PointerEvent): Promise<void> {
    if (this.dragPointerId !== event.pointerId) return;
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
    const dragging = this.draggingId();
    const target = this.dropTargetId();
    const after = this.dropAfter();
    this.dragPointerId = null;
    this.dragCandidateId = null;
    this.clearDrag();

    // Below the threshold the native button's click selects the page, including keyboard and
    // assistive-technology activation. Keeping selection out of pointerup avoids a pointer-only tab.
    if (!dragging) return;
    this.suppressTabClick = true;
    setTimeout(() => { this.suppressTabClick = false; }, 0);
    if (!target || target === dragging) return;
    await this.scratchpad.moveNote(dragging, after ? { afterNoteId: target } : { beforeNoteId: target });
  }

  protected clearDrag(): void {
    this.stopEdgeScroll();
    this.draggingId.set(null);
    this.dropTargetId.set(null);
    this.dropAfter.set(false);
  }

  /** Menu-driven reorder: the touch- and keyboard-reachable equivalent of dragging a tab. */
  protected async moveNoteBy(noteId: string, delta: -1 | 1, event?: Event): Promise<void> {
    event?.stopPropagation();
    this.closeMenu();
    const ordered = this.notes();
    const index = ordered.findIndex((note) => note.id === noteId);
    const neighbour = ordered[index + delta];
    if (!neighbour) return;
    await this.scratchpad.moveNote(
      noteId,
      delta === -1 ? { beforeNoteId: neighbour.id } : { afterNoteId: neighbour.id },
    );
  }

  protected canMove(noteId: string, delta: -1 | 1): boolean {
    const index = this.notes().findIndex((note) => note.id === noteId);
    return index >= 0 && this.notes()[index + delta] !== undefined;
  }

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

  protected tabId(noteId: string): string {
    return `scratchpad-tab-${noteId}`;
  }

  protected pageOptionId(noteId: string): string {
    return `scratchpad-page-option-${noteId}`;
  }

  /** `Created 3 Mar · Updated 10:42` — long-form only when it is not today. The header shows the
   * short form below and keeps this as its tooltip: created-at is worth having, not worth a row. */
  protected metaLine(note: WireScratchpadNote): string {
    return `Created ${this.formatStamp(note.createdAt)} · Updated ${this.formatStamp(note.updatedAt)}`;
  }

  /** `Updated 10:42` — what fits beside the save state in the header row. */
  protected updatedLine(note: WireScratchpadNote): string {
    return `Updated ${this.formatStamp(note.updatedAt)}`;
  }

  private formatStamp(value: Date | string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    const today = new Date();
    const sameDay = date.getDate() === today.getDate()
      && date.getMonth() === today.getMonth()
      && date.getFullYear() === today.getFullYear();
    return sameDay
      ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
      : date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }

  private matchesSheet(): boolean {
    return typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia(SHEET_QUERY).matches;
  }
}
