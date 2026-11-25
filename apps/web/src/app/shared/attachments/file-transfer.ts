import { effect, signal, type WritableSignal } from "@angular/core";

/**
 * DOM helpers for turning drag/paste payloads into attachment uploads. Shared by card detail, the
 * note editor, the description editor and the card composer so the four surfaces accept the same
 * payloads and yield to the same editable targets.
 */

/** Whether a drag carries files (Firefox reports them under its own MIME before `items` fills). */
export function hasDraggedFiles(data: DataTransfer | null | undefined): boolean {
  if (!data) return false;
  if (Array.from(data.types ?? []).some((type) => type === "Files" || type === "application/x-moz-file")) return true;
  return Array.from(data.items ?? []).some((item) => item.kind === "file");
}

/**
 * Files on a clipboard payload. `items` is the reliable source for a screenshot paste (where
 * `files` is empty in some browsers); `files` is the fallback for a copied file from the OS.
 */
export function clipboardAttachmentFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const fromItems = Array.from(data.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  return fromItems.length > 0 ? fromItems : Array.from(data.files ?? []);
}

/** Inputs and rich-text editors handle their own paste, so panel-level handlers must not preempt them. */
export function isEditablePasteTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']"));
}

/**
 * Description/comment editors upload and insert dropped files into their markdown, so a surrounding
 * attachment drop zone must yield while the pointer is over one.
 */
export function isEditorDropTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest("k-description-editor"));
}

/** The element under a drag event, falling back to the pointer position when the target is not an Element. */
export function dragTargetElement(event: DragEvent): Element | null {
  if (event.target instanceof Element) return event.target;
  if (event.clientX || event.clientY) return document.elementFromPoint(event.clientX, event.clientY);
  return null;
}

/**
 * Browsers fire `dragover` every few hundred milliseconds (the spec allows up to 550ms) while a drag
 * is over the page, even when the pointer is still, so a longer silence means the drag is gone.
 */
const FILE_DRAG_SILENCE_MS = 1000;

/**
 * A "file drag is over this drop zone" flag that resets itself when the drag ends without reaching
 * the zone's own handlers. A drag from the OS file manager has no `dragend` here (its source is
 * another app), and cancelling it (Escape, or releasing over another window) fires no `drop` and,
 * on some platforms, no `dragleave` either, which left drop overlays stuck on screen.
 *
 * While the flag is set it clears when the `dragover` stream stops, when the pointer leaves the
 * window, on any `drop`/`dragend`, and on the first pointer event (browsers fire none mid-drag).
 * Must be called in an injection context.
 */
export function fileDragActiveSignal(): WritableSignal<boolean> {
  const active = signal(false);
  effect((onCleanup) => {
    if (!active()) return;
    const end = () => active.set(false);
    let silence = setTimeout(end, FILE_DRAG_SILENCE_MS);
    const rearm = () => {
      clearTimeout(silence);
      silence = setTimeout(end, FILE_DRAG_SILENCE_MS);
    };
    // Browsers fire `dragenter` on the new element before `dragleave` on the old one, so a
    // `dragleave` with no `dragenter` in the same task means the drag left the window. Checking
    // only `relatedTarget` is not enough: Safari reports it as null on every crossing.
    let entering = false;
    const onEnter = () => {
      rearm();
      entering = true;
      setTimeout(() => (entering = false));
    };
    const onLeave = (event: DragEvent) => {
      if (!entering && !event.relatedTarget) end();
    };
    const enders = ["drop", "dragend", "pointerdown", "pointermove"] as const;
    document.addEventListener("dragenter", onEnter, true);
    document.addEventListener("dragover", rearm, true);
    document.addEventListener("dragleave", onLeave, true);
    for (const type of enders) document.addEventListener(type, end, true);
    onCleanup(() => {
      clearTimeout(silence);
      document.removeEventListener("dragenter", onEnter, true);
      document.removeEventListener("dragover", rearm, true);
      document.removeEventListener("dragleave", onLeave, true);
      for (const type of enders) document.removeEventListener(type, end, true);
    });
  });
  return active;
}
