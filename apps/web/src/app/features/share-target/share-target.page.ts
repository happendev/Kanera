import type { OnInit } from "@angular/core";
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from "@angular/core";
import { Router } from "@angular/router";
import type { WireCard } from "@kanera/shared/events";
import type { List, Workspace } from "@kanera/shared/schema";
import { ApiClient, ApiError } from "../../core/api/api.client";
import { STORAGE_KEYS } from "../../core/browser/browser-contracts";
import { NotificationsService } from "../../core/notifications/notifications.service";
import type { HomeBoardWithStats, HomeResponse } from "../../core/offline/offline-cache.service";

const SHARE_TARGET_CACHE = "kanera-share-target-v1";
const SHARE_PAYLOAD_PATH = "/share-target-payload/";

type SharePayload = { title: string; text: string; url: string };
type DestinationPreference = { boardId: string; listId: string };
type ShareBoard = Pick<HomeBoardWithStats, "id" | "workspaceId" | "name" | "viewerRole">;

type ShareWorkspace = {
  workspace: Workspace & { role: string };
  label: string;
  boards: ShareBoard[];
};

function isSharePayload(value: unknown): value is SharePayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<SharePayload>;
  return typeof payload.title === "string" && typeof payload.text === "string" && typeof payload.url === "string";
}

@Component({
  selector: "k-share-target",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./share-target.page.html",
  styleUrls: ["../../shared/page-styles.scss", "./share-target.page.scss"],
})
export class ShareTargetPage implements OnInit {
  readonly title = input<string | null>(null);
  readonly text = input<string | null>(null);
  readonly url = input<string | null>(null);
  readonly shareKey = input<string | null>(null);

  private readonly api = inject(ApiClient);
  private readonly notifications = inject(NotificationsService);
  private readonly router = inject(Router);

  readonly loading = signal(true);
  readonly destinationLoading = signal(false);
  readonly saving = signal(false);
  readonly pasteBusy = signal(false);
  readonly error = signal<string | null>(null);
  readonly captureNotice = signal<string | null>(null);
  readonly hasIncomingContent = signal(false);
  readonly groups = signal<ShareWorkspace[]>([]);
  readonly listsByBoard = signal<Map<string, List[]>>(new Map());
  readonly selectedWorkspaceId = signal("");
  readonly selectedBoardId = signal("");
  readonly selectedListId = signal("");

  readonly cardTitle = signal("");
  readonly description = signal("");

  readonly selectedWorkspace = computed(() =>
    this.groups().find((group) => group.workspace.id === this.selectedWorkspaceId()) ?? null,
  );
  readonly selectedBoards = computed(() => this.selectedWorkspace()?.boards ?? []);
  readonly selectedLists = computed(() => this.listsByBoard().get(this.selectedBoardId()) ?? []);
  readonly canSave = computed(() =>
    !this.loading()
    && !this.destinationLoading()
    && !this.saving()
    && this.cardTitle().trim().length > 0
    && this.selectedBoardId().length > 0
    && this.selectedListId().length > 0,
  );

  async ngOnInit() {
    const payload = await this.consumeSharedPayload();
    this.applySharedPayload(payload);

    try {
      const home = await this.api.get<HomeResponse>("/home/boards");
      const groups = [
        ...home.groups.map((group) => ({
          workspace: group.workspace,
          label: group.workspace.name,
          boards: group.boards.filter((board) => this.canEditBoard(board, group.workspace.role)),
        })),
        ...(home.guestGroups ?? []).map((group) => ({
          workspace: group.workspace,
          label: `${group.workspace.name} · ${group.clientName}`,
          boards: group.boards.filter((board) => this.canEditBoard(board, group.workspace.role)),
        })),
      ]
        .filter((group) => group.boards.length > 0);
      this.groups.set(groups);
      const preference = this.readDestinationPreference();
      const preferredWorkspace = preference
        ? groups.find((group) => group.boards.some((board) => board.id === preference.boardId))
        : null;
      const initialWorkspace = preferredWorkspace ?? groups[0] ?? null;
      if (initialWorkspace) {
        const initialBoard = initialWorkspace.boards.find((board) => board.id === preference?.boardId)
          ?? initialWorkspace.boards[0]!;
        this.selectedWorkspaceId.set(initialWorkspace.workspace.id);
        this.selectedBoardId.set(initialBoard.id);
        await this.loadLists(initialBoard.id, preference?.boardId === initialBoard.id ? preference.listId : undefined);
      }
    } catch {
      this.error.set("Could not load your boards. Check your connection and try again.");
    } finally {
      this.loading.set(false);
    }
  }

  async onWorkspaceChange(value: string) {
    this.error.set(null);
    this.selectedWorkspaceId.set(value);
    const board = this.selectedWorkspace()?.boards[0];
    this.selectedBoardId.set(board?.id ?? "");
    this.selectedListId.set("");
    if (board) await this.loadLists(board.id);
  }

  async onBoardChange(value: string) {
    this.error.set(null);
    this.selectedBoardId.set(value);
    this.selectedListId.set("");
    await this.loadLists(value);
  }

  onListChange(value: string) {
    this.selectedListId.set(value);
    this.rememberDestination();
  }

  setTitle(value: string) {
    this.cardTitle.set(value);
  }

  setDescription(value: string) {
    this.description.set(value);
  }

  cancel() {
    void this.router.navigate(["/"], { replaceUrl: true });
  }

  async pasteFromClipboard() {
    this.captureNotice.set(null);
    if (typeof navigator === "undefined" || !navigator.clipboard?.readText) {
      this.captureNotice.set("Clipboard access is not available here. Paste into the description field instead.");
      return;
    }
    this.pasteBusy.set(true);
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) {
        this.captureNotice.set("Your clipboard is empty.");
        return;
      }
      this.applySharedPayload({ title: "", text, url: "" });
      this.captureNotice.set("Clipboard content added.");
    } catch {
      this.captureNotice.set("Kanera could not read the clipboard. Paste into the description field instead.");
    } finally {
      this.pasteBusy.set(false);
    }
  }

  async save() {
    if (!this.canSave()) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      const clientToken = crypto.randomUUID();
      const card = await this.api.createCard<WireCard>(
        `/boards/${this.selectedBoardId()}/lists/${this.selectedListId()}/cards`,
        {
          title: this.cardTitle().trim(),
          description: this.description().trim() || undefined,
          clientToken,
        },
      );
      this.notifications.watchCreatedCardLocally(card.id);
      this.rememberDestination();
      // Replace the one-time share launch so Back does not reopen an already-consumed payload.
      await this.router.navigate(["/b", card.boardId], { queryParams: { cardId: card.id }, replaceUrl: true });
    } catch (error) {
      this.error.set(error instanceof ApiError && error.status === 0
        ? "You're offline - save this card when Kanera is back online."
        : "Could not create the card. Try a different destination or try again.");
    } finally {
      this.saving.set(false);
    }
  }

  private async loadLists(boardId: string, preferredListId?: string) {
    if (!boardId) return;
    const existing = this.listsByBoard().get(boardId);
    if (existing) {
      this.selectedListId.set(existing.find((list) => list.id === preferredListId)?.id ?? existing[0]?.id ?? "");
      return;
    }
    this.destinationLoading.set(true);
    try {
      // Lists belong to the workspace, but this board-scoped read applies the exact same editor
      // permission as card creation and therefore also works for cross-organisation guests.
      const lists = await this.api.get<List[]>(`/boards/${boardId}/lists`);
      this.listsByBoard.update((map) => {
        const next = new Map(map);
        next.set(boardId, lists);
        return next;
      });
      if (this.selectedBoardId() === boardId) {
        this.selectedListId.set(lists.find((list) => list.id === preferredListId)?.id ?? lists[0]?.id ?? "");
      }
    } catch {
      if (this.selectedBoardId() === boardId) {
        this.selectedListId.set("");
        this.error.set("Could not load lists for this board. Your access may have changed.");
      }
    } finally {
      this.destinationLoading.set(false);
    }
  }

  private applySharedPayload(payload: SharePayload) {
    const title = this.clean(payload.title);
    const text = this.clean(payload.text);
    const explicitUrl = this.clean(payload.url);
    const detectedUrl = explicitUrl || this.firstWebUrl(text);
    const firstTextLine = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line && line !== detectedUrl);
    const derivedTitle = title || firstTextLine || this.urlTitle(detectedUrl) || "New card";
    const descriptionParts = [text];
    if (detectedUrl && !text.includes(detectedUrl)) descriptionParts.push(detectedUrl);

    this.cardTitle.set(derivedTitle.slice(0, 500));
    this.description.set(descriptionParts.filter(Boolean).join("\n\n").slice(0, 50_000));
    this.hasIncomingContent.set(Boolean(title || text || detectedUrl));
  }

  private async consumeSharedPayload(): Promise<SharePayload> {
    const queryPayload = {
      title: this.clean(this.title()),
      text: this.clean(this.text()),
      url: this.clean(this.url()),
    };
    const key = this.clean(this.shareKey());
    if (!key || !/^[0-9a-f-]{36}$/i.test(key) || typeof caches === "undefined") return queryPayload;

    try {
      const cache = await caches.open(SHARE_TARGET_CACHE);
      const payloadUrl = new URL(`${SHARE_PAYLOAD_PATH}${key}`, location.origin).toString();
      const response = await cache.match(payloadUrl);
      if (!response) {
        this.captureNotice.set("The shared content was no longer available. Paste it below to continue.");
        return queryPayload;
      }
      await cache.delete(payloadUrl);
      const payload: unknown = await response.json();
      if (isSharePayload(payload)) return payload;
    } catch {
      // The manual paste path below remains usable when private storage has been cleared or denied.
    }
    this.captureNotice.set("Kanera could not recover the shared content. Paste it below to continue.");
    return queryPayload;
  }

  private canEditBoard(board: ShareBoard, legacyWorkspaceRole: string): boolean {
    if (board.viewerRole) return board.viewerRole === "editor";
    // Rolling deployments and old self-hosted APIs may briefly omit viewerRole. Preserve the old
    // behavior until the API updates; new responses always use the exact board permission above.
    return legacyWorkspaceRole === "admin" || legacyWorkspaceRole === "member" || legacyWorkspaceRole === "editor";
  }

  private firstWebUrl(value: string): string {
    return /https?:\/\/[^\s<>]+/i.exec(value)?.[0]?.replace(/[),.;!?]+$/, "") ?? "";
  }

  private urlTitle(value: string): string {
    if (!value) return "";
    try {
      return new URL(value).hostname.replace(/^www\./, "");
    } catch {
      return value;
    }
  }

  private readDestinationPreference(): DestinationPreference | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.SHARE_TARGET_DESTINATION);
      if (!raw) return null;
      const value = JSON.parse(raw) as Partial<DestinationPreference>;
      return typeof value.boardId === "string" && typeof value.listId === "string"
        ? { boardId: value.boardId, listId: value.listId }
        : null;
    } catch {
      return null;
    }
  }

  private rememberDestination() {
    const boardId = this.selectedBoardId();
    const listId = this.selectedListId();
    if (!boardId || !listId) return;
    try {
      localStorage.setItem(STORAGE_KEYS.SHARE_TARGET_DESTINATION, JSON.stringify({ boardId, listId } satisfies DestinationPreference));
    } catch {
      // Storage can be disabled; destination memory is a convenience, never a save requirement.
    }
  }

  private clean(value: string | null | undefined): string {
    return (value ?? "").trim();
  }
}
