import { Injectable, inject, signal } from "@angular/core";
import type { UserProfileResponse } from "@kanera/shared/dto";
import { ApiClient } from "../../core/api/api.client";
import { viewerTimeZone } from "../day-key.util";

/** A surface-specific action shown in the profile card's footer, e.g. "Unassign" on a card. */
export interface UserProfileAction {
  id: string;
  label: string;
  icon: string;
  tone?: "danger";
  run: () => void | Promise<void>;
}

/** What the clicked avatar already knows. Painted immediately so the card never opens blank. */
export interface UserProfileTarget {
  userId: string;
  workspaceId: string | null;
  displayName: string;
  avatarUrl: string | null;
  lastOnlineAt: string | Date | null;
  actions?: readonly UserProfileAction[];
}

export interface UserProfileRequest extends UserProfileTarget {
  /** Unique per open, so the popover is rebuilt (and re-registered with the panel stack) each time. */
  id: number;
  anchor: HTMLElement;
}

/** Long enough that flicking between a few avatars is instant; short enough that stats stay honest. */
const PROFILE_CACHE_MS = 60_000;

/**
 * Owns the single, app-wide profile card.
 *
 * The card is rendered once by the shell rather than inside each avatar. Avatars live in card tiles,
 * table cells and virtualised lanes whose ancestors can trap `position: fixed` (transforms during a
 * drag, layout containment) or be torn down by a re-render while the card is open, and a thousand
 * avatars on a board must not each carry a popover's worth of bindings.
 */
@Injectable({ providedIn: "root" })
export class UserProfileCardService {
  private readonly api = inject(ApiClient);
  private nextId = 1;
  private readonly cache = new Map<string, { at: number; promise: Promise<UserProfileResponse> }>();

  readonly current = signal<UserProfileRequest | null>(null);

  /** Opens the card for an avatar, or closes it when that same avatar's card is already showing. */
  toggle(anchor: HTMLElement, target: UserProfileTarget): void {
    const open = this.current();
    if (open && open.anchor === anchor) {
      this.close();
      return;
    }
    this.current.set({ ...target, anchor, id: this.nextId++ });
  }

  close(): void {
    this.current.set(null);
  }

  isOpenFor(anchor: HTMLElement): boolean {
    return this.current()?.anchor === anchor;
  }

  load(userId: string, workspaceId: string | null, options: { force?: boolean } = {}): Promise<UserProfileResponse> {
    const timeZone = viewerTimeZone();
    const key = `${userId}|${workspaceId ?? ""}|${timeZone}`;
    const cached = this.cache.get(key);
    if (!options.force && cached && Date.now() - cached.at < PROFILE_CACHE_MS) return cached.promise;

    const params = new URLSearchParams({ timeZone });
    if (workspaceId) params.set("workspaceId", workspaceId);
    const promise = this.api.get<UserProfileResponse>(`/users/${encodeURIComponent(userId)}/profile?${params.toString()}`);
    this.cache.set(key, { at: Date.now(), promise });
    // A failure must not be served from cache for the next minute; the retry button should retry.
    promise.catch(() => {
      if (this.cache.get(key)?.promise === promise) this.cache.delete(key);
    });
    return promise;
  }
}
