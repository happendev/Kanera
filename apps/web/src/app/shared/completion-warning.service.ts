import { Injectable, inject } from "@angular/core";
import type { CompletionWarningBody, CompletionWarningResponse } from "@kanera/shared/dto";
import { ApiClient } from "../core/api/api.client";
import { AuthService } from "../core/auth/auth.service";
import { ConfirmService } from "./confirm.service";

/** Advisory UI preflight, shared by detail, menus, queues and bulk completion. No hidden titles. */
@Injectable({ providedIn: "root" })
export class CompletionWarningService {
  private readonly api = inject(ApiClient);
  private readonly confirm = inject(ConfirmService);
  private readonly auth = inject(AuthService);

  async allow(completed: boolean, selection: CompletionWarningBody): Promise<boolean> {
    const userId = this.auth.user()?.id;
    if (!completed || (userId && isSkipped(userId))) return true;
    if ("cardIds" in selection && !selection.cardIds.length) return true;
    let blockedCardCount: number;
    try {
      ({ blockedCardCount } = await this.api.post<CompletionWarningResponse>("/cards/completion-warning", selection));
    } catch {
      // Advisory only: a failed preflight must never stop someone finishing their work.
      return true;
    }
    if (!blockedCardCount) return true;
    return this.confirm.open({
      title: $localize`:Completion warning title:Complete blocked work?`,
      message: $localize`:Completion warning:Some selected work still has active blockers. You can complete it anyway.`,
      confirmLabel: $localize`:Completion warning action:Complete anyway`,
      danger: false,
      checkbox: {
        label: $localize`:Completion warning preference:Don't warn again this session`,
        onConfirm: (checked) => { if (checked && userId) skipFor(userId); },
      },
    });
  }
}

// "This session" means the browser session: it survives a reload or PWA relaunch, not a new tab.
// Storage may be unavailable (private mode, blocked site data); then the warning simply shows again.
const SKIP_KEY_PREFIX = "kanera:completion-warning:skip:";
function isSkipped(userId: string): boolean {
  try { return sessionStorage.getItem(SKIP_KEY_PREFIX + userId) === "1"; } catch { return false; }
}
function skipFor(userId: string): void {
  try { sessionStorage.setItem(SKIP_KEY_PREFIX + userId, "1"); } catch { /* best effort */ }
}
