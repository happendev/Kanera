import type { OnDestroy } from "@angular/core";
import { Injectable, signal } from "@angular/core";

export interface ActionToast {
  id: number;
  message: string;
  icon: string;
  success: boolean;
  /** Present on undoable toasts; rendered as the toast's single action button. */
  action?: { label: string; run: () => void };
}

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

/** How long an undo stays available. Matches the plain success toast so the stack ages uniformly. */
export const UNDO_WINDOW_MS = 6000;

@Injectable({ providedIn: "root" })
export class ActionToastService implements OnDestroy {
  private nextId = 0;
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly commits = new Map<number, () => void | Promise<void>>();
  readonly messages = signal<ActionToast[]>([]);

  constructor() {
    // A deferred delete that is still waiting on its toast must not evaporate with the tab. pagehide
    // fires for close, reload and bfcache navigation, and the DELETEs go out with keepalive (see
    // ApiClient.delete) so the browser lets them finish after the document is gone.
    if (typeof window !== "undefined") window.addEventListener("pagehide", this.flushPending);
  }

  // Application ownership keeps confirmations alive after a menu or card drawer closes.
  success(message: string, icon: string) {
    this.push({ message, icon, success: true });
  }

  /** Neutral notice (for example a failed undo). Same slot and lifetime as success. */
  info(message: string, icon: string) {
    this.push({ message, icon, success: false });
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
      success: true,
      action: { label: options.undoLabel ?? "Undo", run: () => this.undo(id, options.undo) },
    });
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
  }

  private push(toast: Omit<ActionToast, "id">): number {
    const id = ++this.nextId;
    this.messages.update((messages) => [...messages, { ...toast, id }]);
    this.timers.set(id, setTimeout(() => this.dismiss(id), UNDO_WINDOW_MS));
    return id;
  }

  private remove(id: number) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.commits.delete(id);
    this.messages.update((messages) => messages.filter((message) => message.id !== id));
  }

  private async undo(id: number, undo: () => void | Promise<void>) {
    // Drop the commit before anything async so a timer firing mid-undo cannot delete what the user
    // just asked to keep.
    this.remove(id);
    try {
      await undo();
    } catch {
      this.info("Couldn't undo that. Refresh to see the current state.", "alert-triangle");
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
