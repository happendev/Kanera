import { Injectable, inject, type OnDestroy } from "@angular/core";
import type { CanDeactivateFn } from "@angular/router";

const UNSAVED_WORK_MESSAGE = "You have unsaved work. Are you sure you want to leave?";

/**
 * Tracks editors whose current value has not been published yet. Browser unloads need the native
 * beforeunload contract, while Angular navigation needs an explicit confirmation because it does
 * not unload the document.
 */
@Injectable({ providedIn: "root" })
export class UnsavedWorkService implements OnDestroy {
  private readonly dirtySources = new Set<symbol>();

  constructor() {
    window.addEventListener("beforeunload", this.handleBeforeUnload);
  }

  ngOnDestroy(): void {
    window.removeEventListener("beforeunload", this.handleBeforeUnload);
  }

  setDirty(source: symbol, dirty: boolean): void {
    if (dirty) this.dirtySources.add(source);
    else this.dirtySources.delete(source);
  }

  hasUnsavedWork(): boolean {
    return this.dirtySources.size > 0;
  }

  isDirty(source: symbol): boolean {
    return this.dirtySources.has(source);
  }

  confirmNavigation(): boolean {
    return this.confirm(this.hasUnsavedWork());
  }

  // Prompt only when `dirty` is true. Callers closing a sub-view (e.g. the checklist item drawer)
  // pass just that view's own dirty state so an unrelated dirty editor elsewhere on the page does
  // not trigger a prompt when the closed view itself is clean.
  confirm(dirty: boolean): boolean {
    return !dirty || window.confirm(UNSAVED_WORK_MESSAGE);
  }

  private readonly handleBeforeUnload = (event: BeforeUnloadEvent): void => {
    if (!this.hasUnsavedWork()) return;
    event.preventDefault();
    // Required by older browsers; current browsers intentionally show their own standard copy.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    event.returnValue = "";
  };
}

export const unsavedWorkCanDeactivateGuard: CanDeactivateFn<unknown> = () =>
  inject(UnsavedWorkService).confirmNavigation();
