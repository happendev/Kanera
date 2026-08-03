import { Injectable, effect, inject, signal } from "@angular/core";
import { AuthService } from "../auth/auth.service";
import { organisationStorageKey, STORAGE_KEYS } from "../browser/browser-contracts";

const MAX_RECENT_BOARDS = 5;

@Injectable({ providedIn: "root" })
export class RecentBoardsService {
  private readonly auth = inject(AuthService);
  readonly boardIds = signal<string[]>([]);

  constructor() {
    effect(() => this.boardIds.set(this.read(this.auth.user()?.clientId)));
  }

  record(boardId: string): void {
    const next = [boardId, ...this.boardIds().filter((id) => id !== boardId)].slice(0, MAX_RECENT_BOARDS);
    this.boardIds.set(next);
    localStorage.setItem(this.storageKey(), JSON.stringify(next));
  }

  private storageKey(clientId: string | null | undefined = this.auth.user()?.clientId): string {
    return organisationStorageKey(STORAGE_KEYS.RECENT_BOARDS, clientId);
  }

  private read(clientId: string | null | undefined): string[] {
    try {
      const raw = localStorage.getItem(this.storageKey(clientId));
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string").slice(0, MAX_RECENT_BOARDS) : [];
    } catch {
      return [];
    }
  }
}
