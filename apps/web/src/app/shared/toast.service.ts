import type { OnDestroy } from "@angular/core";
import { Injectable, computed, signal } from "@angular/core";

/**
 * Visual tone of a toast. Only the icon colour changes between variants so a stack of mixed toasts
 * still reads as one system; the copy carries the meaning.
 */
export type ToastVariant = "success" | "error" | "info";

export interface Toast {
  id: number;
  message: string;
  icon: string;
  variant: ToastVariant;
  /** Present on undoable toasts; rendered as the toast's single action button. */
  action?: { label: string; run: () => void };
}

/** A toast plus whether it is playing its exit animation. Only the stack renderer needs the flag. */
export interface RenderedToast extends Toast {
  leaving: boolean;
}

/**
 * How long a toast stays mounted after it is dismissed so `k-toast` can animate it out. Must cover
 * the exit keyframes in toast.component.ts; a shorter value would cut the fade and snap the stack.
 */
export const TOAST_EXIT_MS = 200;

export interface UndoableToastOptions {
  message: string;
  icon: string;
  /**
   * Reverses the action. For work that already hit the server (archive) this issues the restoring
   * request; for deferred work (hard deletes) it just puts the locally hidden item back.
   */
  undo: () => void | Promise<void>;
  /**
   * Runs once the toast expires or is dismissed without Undo. Deferred deletes send their DELETE
   * here, so the server never sees a request the user reversed. Must handle its own failures:
   * the toast is gone by the time it runs and nothing else will report the error.
   */
  commit?: () => void | Promise<void>;
  undoLabel?: string;
}

/** Lifetime of a plain confirmation or error toast. */
export const TOAST_LIFETIME_MS = 6000;

/**
 * How long an undo stays available. Longer than a plain toast: the user has to notice the toast,
 * read it and reach the button, and for deferred deletes this is also the grace period before the
 * DELETE is sent, so erring long costs nothing but a slightly later request.
 */
export const UNDO_WINDOW_MS = 10000;

/**
 * The one transient-feedback channel for the app. Every "that worked" / "that failed" message goes
 * through here so confirmations look, stack and expire the same way whether they come from a board
 * menu, a settings form or a background undo. Forms that save themselves use `AutosaveTracker` and
 * the `k-autosave-status` chip instead: a toast per keystroke would be noise.
 */
@Injectable({ providedIn: "root" })
export class ToastService implements OnDestroy {
  private nextId = 0;
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly exitTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly commits = new Map<number, () => void | Promise<void>>();
  private readonly all = signal<RenderedToast[]>([]);
  /** Everything the stack should render, including toasts mid-exit. */
  readonly rendered = this.all.asReadonly();
  /** Live toasts only. A dismissed toast leaves this list at once even though it is still fading out. */
  readonly messages = computed<Toast[]>(() => this.all().filter((toast) => !toast.leaving));

  constructor() {
    // A deferred delete that is still waiting on its toast must not evaporate with the tab. pagehide
    // fires for close, reload and bfcache navigation, and the DELETEs go out with keepalive (see
    // ApiClient.delete) so the browser lets them finish after the document is gone.
    if (typeof window !== "undefined") window.addEventListener("pagehide", this.flushPending);
  }

  // Application ownership keeps confirmations alive after a menu or card drawer closes.
  success(message: string, icon = "circle-check") {
    this.push({ message, icon, variant: "success" }, TOAST_LIFETIME_MS);
  }

  /**
   * Failure the user should know about but that has no form to anchor an inline error to (a failed
   * undo, a background action). Validation errors belong next to the field, not here.
   */
  error(message: string, icon = "alert-circle") {
    this.push({ message, icon, variant: "error" }, TOAST_LIFETIME_MS);
  }

  /** Neutral notice. Same slot and lifetime as success. */
  info(message: string, icon: string) {
    this.push({ message, icon, variant: "info" }, TOAST_LIFETIME_MS);
  }

  /**
   * Success toast with an Undo button. Undo dismisses the toast and skips `commit`; expiry or the
   * close button commits. Returns the toast id so a caller can force an early commit if the same
   * entity is acted on again before the window closes.
   */
  undoable(options: UndoableToastOptions): number {
    const id = this.push({
      message: options.message,
      icon: options.icon,
      variant: "success",
      action: { label: options.undoLabel ?? "Undo", run: () => this.undo(id, options.undo) },
    }, UNDO_WINDOW_MS);
    if (options.commit) this.commits.set(id, options.commit);
    return id;
  }

  /** Close a toast. Any deferred commit attached to it runs now. */
  dismiss(id: number) {
    const commit = this.commits.get(id);
    this.remove(id);
    if (commit) void this.runCommit(commit);
  }

  /** Commit every pending deferred action immediately. Used on page hide and service teardown. */
  readonly flushPending = () => {
    for (const id of [...this.commits.keys()]) this.dismiss(id);
  };

  ngOnDestroy() {
    if (typeof window !== "undefined") window.removeEventListener("pagehide", this.flushPending);
    this.flushPending();
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const timer of this.exitTimers.values()) clearTimeout(timer);
  }

  private push(toast: Omit<Toast, "id">, lifetimeMs: number): number {
    const id = ++this.nextId;
    this.all.update((toasts) => [...toasts, { ...toast, id, leaving: false }]);
    this.timers.set(id, setTimeout(() => this.dismiss(id), lifetimeMs));
    return id;
  }

  private remove(id: number) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.commits.delete(id);
    // Keep the entry mounted with `leaving` set so the primitive can animate out; a second remove for
    // the same id (dismiss racing expiry) must not restart the exit clock.
    if (this.exitTimers.has(id)) return;
    this.all.update((toasts) => toasts.map((toast) => toast.id === id ? { ...toast, leaving: true } : toast));
    this.exitTimers.set(id, setTimeout(() => {
      this.exitTimers.delete(id);
      this.all.update((toasts) => toasts.filter((toast) => toast.id !== id));
    }, TOAST_EXIT_MS));
  }

  private async undo(id: number, undo: () => void | Promise<void>) {
    // Drop the commit before anything async so a timer firing mid-undo cannot delete what the user
    // just asked to keep.
    this.remove(id);
    try {
      await undo();
    } catch {
      this.error("Couldn't undo that. Refresh to see the current state.", "alert-triangle");
    }
  }

  private async runCommit(commit: () => void | Promise<void>) {
    try {
      await commit();
    } catch {
      // Callers own failure handling (restore their local state); see UndoableToastOptions.commit.
    }
  }
}
