import type { DestroyRef } from "@angular/core";
import { signal } from "@angular/core";

export type AutosaveState = "idle" | "saving" | "saved" | "error";

/** How long "Saved" stays visible before the chip returns to idle. */
export const AUTOSAVE_SAVED_VISIBLE_MS = 2500;

/**
 * State for a form that saves itself. Pair it with `k-autosave-status`: the chip is the visible
 * contract that a blur or toggle actually persisted, since there is no Save button to press.
 * "Saved" is deliberately transient so the indicator never becomes permanent chrome; "error"
 * sticks until the next attempt so a failed save cannot be missed. Explicit Save buttons should
 * confirm through `ToastService` instead.
 */
export class AutosaveTracker {
  readonly state = signal<AutosaveState>("idle");
  private savedTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(destroyRef?: DestroyRef) {
    destroyRef?.onDestroy(() => this.destroy());
  }

  /** Runs `work`, reflecting it in `state`. Rethrows so callers keep their own rollback handling. */
  async track<T>(work: () => Promise<T>): Promise<T> {
    this.markSaving();
    try {
      const result = await work();
      this.markSaved();
      return result;
    } catch (error) {
      this.markError();
      throw error;
    }
  }

  markSaving(): void {
    this.clearSavedTimer();
    this.state.set("saving");
  }

  markSaved(): void {
    this.clearSavedTimer();
    this.state.set("saved");
    this.savedTimer = setTimeout(() => {
      this.savedTimer = null;
      if (this.state() === "saved") this.state.set("idle");
    }, AUTOSAVE_SAVED_VISIBLE_MS);
  }

  /** Back to idle without a result, for a save the user cancelled before it was sent. */
  reset(): void {
    this.clearSavedTimer();
    this.state.set("idle");
  }

  markError(): void {
    this.clearSavedTimer();
    this.state.set("error");
  }

  destroy(): void {
    this.clearSavedTimer();
  }

  private clearSavedTimer(): void {
    if (this.savedTimer === null) return;
    clearTimeout(this.savedTimer);
    this.savedTimer = null;
  }
}
