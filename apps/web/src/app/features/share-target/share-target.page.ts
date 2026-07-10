import type { OnInit } from "@angular/core";
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from "@angular/core";
import { Router } from "@angular/router";
import type { WireCard } from "@kanera/shared/events";
import type { Board, List, Workspace } from "@kanera/shared/schema";
import { ApiClient, ApiError } from "../../core/api/api.client";
import { NotificationsService } from "../../core/notifications/notifications.service";
import type { HomeResponse } from "../../core/offline/offline-cache.service";

type ShareWorkspace = {
  workspace: Workspace & { role: string };
  boards: Pick<Board, "id" | "workspaceId" | "name">[];
};

// Any workspace member may reach the share flow; whether they can actually create a card is
// enforced per-board on the server (they need editor access to the chosen board). Workspace role
// alone no longer determines card-creation capability now that access is board-level.
function canCreateCards(role: string): boolean {
  return role === "admin" || role === "member";
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

  private readonly api = inject(ApiClient);
  private readonly notifications = inject(NotificationsService);
  private readonly router = inject(Router);

  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly groups = signal<ShareWorkspace[]>([]);
  readonly listsByWorkspace = signal<Map<string, List[]>>(new Map());
  readonly selectedWorkspaceId = signal("");
  readonly selectedBoardId = signal("");
  readonly selectedListId = signal("");

  readonly cardTitle = signal("");
  readonly description = signal("");

  readonly selectedWorkspace = computed(() =>
    this.groups().find((group) => group.workspace.id === this.selectedWorkspaceId()) ?? null,
  );
  readonly selectedBoards = computed(() => this.selectedWorkspace()?.boards ?? []);
  readonly selectedLists = computed(() => this.listsByWorkspace().get(this.selectedWorkspaceId()) ?? []);
  readonly canSave = computed(() =>
    !this.loading()
    && !this.saving()
    && this.cardTitle().trim().length > 0
    && this.selectedBoardId().length > 0
    && this.selectedListId().length > 0,
  );

  async ngOnInit() {
    this.cardTitle.set(this.initialTitle());
    this.description.set(this.initialDescription());

    try {
      const home = await this.api.get<HomeResponse>("/home/boards");
      const groups = home.groups
        .filter((group) => canCreateCards(group.workspace.role))
        .map((group) => ({
          workspace: group.workspace,
          boards: group.boards,
        }))
        .filter((group) => group.boards.length > 0);
      this.groups.set(groups);
      const firstWorkspace = groups[0] ?? null;
      if (firstWorkspace) {
        this.selectedWorkspaceId.set(firstWorkspace.workspace.id);
        this.selectedBoardId.set(firstWorkspace.boards[0]?.id ?? "");
        await this.loadLists(firstWorkspace.workspace.id);
      }
    } catch {
      this.error.set("Could not load your boards. Check your connection and try again.");
    } finally {
      this.loading.set(false);
    }
  }

  async onWorkspaceChange(value: string) {
    this.selectedWorkspaceId.set(value);
    const board = this.selectedWorkspace()?.boards[0];
    this.selectedBoardId.set(board?.id ?? "");
    this.selectedListId.set("");
    await this.loadLists(value);
  }

  onBoardChange(value: string) {
    this.selectedBoardId.set(value);
  }

  onListChange(value: string) {
    this.selectedListId.set(value);
  }

  setTitle(value: string) {
    this.cardTitle.set(value);
  }

  setDescription(value: string) {
    this.description.set(value);
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
      await this.router.navigate(["/b", card.boardId], { queryParams: { cardId: card.id } });
    } catch (error) {
      this.error.set(error instanceof ApiError && error.status === 0
        ? "You're offline - save this card when Kanera is back online."
        : "Could not create the card. Try a different destination or try again.");
    } finally {
      this.saving.set(false);
    }
  }

  private async loadLists(workspaceId: string) {
    if (!workspaceId) return;
    const existing = this.listsByWorkspace().get(workspaceId);
    if (existing) {
      this.selectedListId.set(existing[0]?.id ?? "");
      return;
    }
    const detail = await this.api.get<{ lists: List[] }>(`/workspaces/${workspaceId}`);
    const lists = detail.lists.filter((list) => !list.archivedAt);
    this.listsByWorkspace.update((map) => {
      const next = new Map(map);
      next.set(workspaceId, lists);
      return next;
    });
    this.selectedListId.set(lists[0]?.id ?? "");
  }

  private initialTitle(): string {
    const title = this.clean(this.title());
    if (title) return title.slice(0, 500);
    const text = this.clean(this.text());
    if (text) return text.split(/\r?\n/)[0]!.slice(0, 500);
    const url = this.clean(this.url());
    return url ? url.slice(0, 500) : "Shared item";
  }

  private initialDescription(): string {
    const parts = [this.clean(this.text()), this.clean(this.url())].filter(Boolean);
    return [...new Set(parts)].join("\n\n").slice(0, 50_000);
  }

  private clean(value: string | null): string {
    return (value ?? "").trim();
  }
}
