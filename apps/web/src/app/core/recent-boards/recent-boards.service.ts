import { Injectable, signal } from "@angular/core";
import { STORAGE_KEYS } from "../browser/browser-contracts";

const MAX_RECENT_BOARDS = 5;

@Injectable({ providedIn: "root" })
export class RecentBoardsService {
  readonly boardIds = signal<string[]>(this.read());

  record(boardId: string): void {
    const next = [boardId, ...this.boardIds().filter((id) => id !== boardId)].slice(0, MAX_RECENT_BOARDS);
    this.boardIds.set(next);
    localStorage.setItem(STORAGE_KEYS.RECENT_BOARDS, JSON.stringify(next));
  }

  private read(): string[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.RECENT_BOARDS);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string").slice(0, MAX_RECENT_BOARDS) : [];
    } catch {
      return [];
    }
  }
}
