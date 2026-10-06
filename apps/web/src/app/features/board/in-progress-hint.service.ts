import { Injectable, signal } from "@angular/core";
import { STORAGE_KEYS } from "../../core/browser/browser-contracts";

/**
 * Whether the "what does In progress mean" banner still shows on in-progress list columns.
 *
 * One shared flag, not per list: the banner explains a concept, so dismissing it on one column
 * dismisses it everywhere (every board, Global Work) instead of reappearing on the next column.
 */
@Injectable({ providedIn: "root" })
export class InProgressHintService {
  private readonly dismissedState = signal(readDismissed());
  readonly dismissed = this.dismissedState.asReadonly();

  dismiss(): void {
    this.dismissedState.set(true);
    try {
      localStorage.setItem(STORAGE_KEYS.IN_PROGRESS_HINT_DISMISSED, "1");
    } catch {
      // Storage can be unavailable in hardened contexts; the banner stays dismissed for this session.
    }
  }
}

function readDismissed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEYS.IN_PROGRESS_HINT_DISMISSED) === "1";
  } catch {
    return false;
  }
}
