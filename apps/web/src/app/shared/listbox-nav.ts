import { computed, signal } from "@angular/core";

interface ListboxItem {
  key: string;
  disabled?: boolean | null;
}

let nextListboxId = 0;

/**
 * Keyboard model for a searchable picker: a combobox (the search input) that owns an active row in a
 * listbox via `aria-activedescendant`, so focus never leaves the search and typing keeps filtering.
 * Shared by `k-picker-list` and the board's label, member and option pickers, which render their own
 * rows but must move through them the same way.
 *
 * The active row is tracked by key, not index, so a realtime update that reorders or inserts rows
 * keeps the same row active instead of silently shifting the highlight onto a neighbour.
 *
 * Arrow keys wrap (last → first and back): a picker is short and wrapping is what every other
 * popover list in the app does with the keyboard, so there is no dead end to back out of.
 */
export class ListboxNav {
  readonly listId = `k-listbox-${++nextListboxId}`;
  readonly activeKey = signal<string | null>(null);

  readonly activeIndex = computed(() => {
    const key = this.activeKey();
    if (key === null) return -1;
    return this.items().findIndex((item) => item.key === key && !item.disabled);
  });

  /** Id for the combobox's `aria-activedescendant`; null when no rendered row is active. */
  readonly activeDescendant = computed(() => {
    const index = this.activeIndex();
    return index < 0 ? null : this.optionId(this.items()[index]!.key);
  });

  constructor(private readonly items: () => readonly ListboxItem[]) {}

  optionId(key: string): string {
    return `${this.listId}-opt-${key.replace(/\s+/g, "_")}`;
  }

  isActive(key: string): boolean {
    return this.activeKey() === key;
  }

  /**
   * Call whenever the filter text changes. A non-empty query makes the top hit active, so typing
   * and pressing Enter picks it; clearing the query drops the highlight so an unfiltered list opens
   * with nothing armed and a stray Enter does not toggle the first row.
   */
  resetFor(query: string): void {
    this.activeKey.set(query.trim() ? this.enabled()[0]?.key ?? null : null);
  }

  /**
   * Mouse hover moves the active row too, so keyboard and pointer never highlight two different
   * rows for long. Touch is excluded (a tap is a pick, not a hover), and so are zero-distance moves,
   * which some browsers synthesise when the list scrolls under a resting pointer and which would
   * otherwise yank the active row back while the user is arrowing through a long list.
   */
  hover(key: string, event: PointerEvent): void {
    if (event.pointerType === "touch") return;
    if (event.movementX === 0 && event.movementY === 0) return;
    this.activeKey.set(key);
  }

  /**
   * Handles ArrowUp/ArrowDown/Home/End/Enter for the search input and, when a picker has no search,
   * for its focused rows. From a row, focus itself moves (roving focus) and Enter is left to the
   * native button click; from the search, focus stays put and Enter activates the active row.
   */
  onKeydown(event: KeyboardEvent, activate: (key: string) => void): void {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    const enabled = this.enabled();
    if (!enabled.length) return;
    const target = event.target as HTMLElement | null;
    const fromRow = target?.getAttribute?.("role") === "option";
    // A focused row is where the user is, whatever the pointer last hovered.
    const current = fromRow
      ? enabled.findIndex((item) => this.optionId(item.key) === target!.id)
      : enabled.findIndex((item) => item.key === this.activeKey());

    let next: number;
    switch (event.key) {
      case "ArrowDown":
        next = current < 0 ? 0 : (current + 1) % enabled.length;
        break;
      case "ArrowUp":
        next = current < 0 ? enabled.length - 1 : (current - 1 + enabled.length) % enabled.length;
        break;
      case "Home":
        if (event.shiftKey) return;
        next = 0;
        break;
      case "End":
        if (event.shiftKey) return;
        next = enabled.length - 1;
        break;
      case "Enter":
        if (fromRow || current < 0) return;
        event.preventDefault();
        activate(enabled[current]!.key);
        return;
      default:
        return;
    }

    event.preventDefault();
    const key = enabled[next]!.key;
    this.activeKey.set(key);
    // The row already exists (moving the highlight renders nothing new), so it can be found now.
    // Looked up from the event's own root rather than the global document so a picker inside a
    // shadow root or a detached tree still finds its row.
    const id = this.optionId(key);
    const root = (event.target as Node | null)?.getRootNode?.();
    const options = root instanceof Document || root instanceof DocumentFragment || root instanceof Element
      ? (Array.from(root.querySelectorAll('[role="option"]')) as HTMLElement[])
      : [];
    const row = options.find((el) => el.id === id) ?? null;
    if (fromRow) row?.focus();
    row?.scrollIntoView?.({ block: "nearest" });
  }

  private enabled(): ListboxItem[] {
    return this.items().filter((item) => !item.disabled);
  }
}
