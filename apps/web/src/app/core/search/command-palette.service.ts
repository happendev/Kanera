import type { DestroyRef } from "@angular/core";
import { Injectable, computed, signal } from "@angular/core";

/**
 * One runnable entry in the ⌘K palette. Distinct from a keyboard shortcut: an action need not have a
 * key, and the label is written for reading in a list ("Create a new board"), not for a shortcut sheet.
 */
export interface PaletteAction {
  /** Stable id; also the `track` key in the overlay. */
  id: string;
  label: string;
  /**
   * One line under the label: where the action lands or what it changes. A function when the target
   * depends on state, e.g. which board a new card lands on; read inside a computed, so it may use signals.
   */
  detail: string | (() => string);
  /** Tabler icon name without the `ti-` prefix. */
  icon: string;
  /** Extra words the query may match that are not in the label, e.g. "dark" for the theme toggle. */
  keywords?: string[];
  /**
   * The keyboard shortcut that does the same thing, in the dispatcher's `ShortcutKeys` grammar, so the
   * palette teaches the faster route. A function when it depends on context (e.g. `c` only on a board).
   */
  keys?: string | (() => string | undefined);
  /**
   * Hidden while false. Read inside a computed, so it may depend on signals. This is where permission
   * lives: an action the user is not allowed to take must not be listed, rather than listed and refused.
   */
  when?: () => boolean;
  run: () => void;
}

/**
 * Registry the palette renders from. Owners register the actions they can actually perform — the
 * shell owns board creation, the personal panels and notifications, so it registers those — and the
 * overlay stays a dumb list that never has to know about dialogs, plan limits or panel state.
 * Registration order is display order; register the most-used creation verbs first.
 */
@Injectable({ providedIn: "root" })
export class CommandPaletteService {
  private readonly registrations = signal<PaletteAction[][]>([]);

  readonly actions = computed(() => this.registrations().flat());

  registerAll(actions: PaletteAction[], destroyRef: DestroyRef): void {
    this.registrations.update((groups) => [...groups, actions]);
    destroyRef.onDestroy(() => this.registrations.update((groups) => groups.filter((group) => group !== actions)));
  }
}

/**
 * Every whitespace-separated query token must appear somewhere in the label, detail or keywords, so
 * "new board", "board new" and "boa" all find "Create a new board". Substring rather than fuzzy: a
 * palette that matches "cbd" to "Create a new board" surprises more than it helps.
 */
export function actionMatchesQuery(action: Pick<PaletteAction, "label" | "detail" | "keywords">, query: string): boolean {
  const tokens = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = [action.label, resolveDetail(action.detail), ...(action.keywords ?? [])].join(" ").toLocaleLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

export function resolveDetail(detail: PaletteAction["detail"]): string {
  return typeof detail === "function" ? detail() : detail;
}
