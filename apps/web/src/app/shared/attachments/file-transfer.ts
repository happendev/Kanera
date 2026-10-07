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
