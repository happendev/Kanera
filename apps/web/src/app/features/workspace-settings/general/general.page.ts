import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from "@angular/core";
import type { Board, StandaloneBoardGroup } from "@kanera/shared/schema";
import { ApiClient, ApiError } from "../../../core/api/api.client";
import { AnchoredPanelDirective } from "../../../shared/anchored-panel.directive";
import { ColorPickerComponent } from "../../../shared/color-picker.component";
import { DocsLinkComponent } from "../../../shared/docs-link.component";
import { IconPickerComponent } from "../../../shared/icon-picker.component";
import { WorkspaceSettingsPage } from "../workspace-settings.page";

@Component({
  selector: "k-workspace-settings-general",
  standalone: true,
  imports: [AnchoredPanelDirective, ColorPickerComponent, DocsLinkComponent, IconPickerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./general.page.html",
  styleUrl: "./general.page.scss",
})
export class WorkspaceSettingsGeneralPage {
  protected readonly settings = inject(WorkspaceSettingsPage);
  private readonly api = inject(ApiClient);
  private loadedBoardId: string | null = null;
  readonly standaloneGroups = signal<StandaloneBoardGroup[]>([]);
  readonly cardKeyPrefix = signal("");
  readonly cardKeyPrefixSaving = signal(false);
  readonly cardKeyPrefixError = signal<string | null>(null);
  readonly standaloneGroupTitle = signal("");
  private standaloneGroupSavedTitle = "";
  readonly standaloneGroupSaving = signal(false);
  readonly standaloneGroupError = signal<string | null>(null);
  readonly standaloneGroupMenuOpen = signal(false);
  readonly standaloneGroupActiveIndex = signal(-1);
  readonly standaloneGroupPlacement = { width: 420, maxHeight: 220, minHeight: 120 } as const;
  readonly standaloneGroupChoices = computed(() => {
    const query = this.standaloneGroupTitle().trim();
    const normalizedQuery = query.toLocaleLowerCase();
    const groups = this.standaloneGroups()
      .filter((group) => !normalizedQuery || group.title.toLocaleLowerCase().includes(normalizedQuery))
      .map((group) => ({ key: group.id, title: group.title, kind: "existing" as const }));

    if (!query || this.standaloneGroups().some((group) => group.title.toLocaleLowerCase() === normalizedQuery)) return groups;
    return [...groups, { key: "create", title: query, kind: "create" as const }];
  });

  constructor() {
    this.settings.selectedTab.set("general");
    effect(() => {
      const prefix = this.settings.workspace()?.cardKeyPrefix;
      if (prefix) untracked(() => this.cardKeyPrefix.set(prefix));
    });
    effect(() => {
      const boardId = this.settings.boardId();
      if (!this.settings.isStandalone() || !boardId || boardId === this.loadedBoardId) return;
      this.loadedBoardId = boardId;
      untracked(() => void this.loadStandaloneGrouping(boardId));
    });
  }

  async saveCardKeyPrefix() {
    if (this.cardKeyPrefixSaving()) return;
    const prefix = this.cardKeyPrefix().trim().toUpperCase();
    this.cardKeyPrefix.set(prefix);
    if (prefix === this.settings.workspace()?.cardKeyPrefix) return;
    if (!/^[A-Z][A-Z0-9]{1,9}$/.test(prefix)) {
      this.cardKeyPrefixError.set("Use 2–10 letters or numbers, starting with a letter.");
      return;
    }
    this.cardKeyPrefixSaving.set(true);
    this.cardKeyPrefixError.set(null);
    try {
      await this.settings.updateCardKeyPrefix(prefix);
    } catch (error) {
      this.cardKeyPrefixError.set(this.cardKeyPrefixErrorMessage(error));
      this.cardKeyPrefix.set(this.settings.workspace()?.cardKeyPrefix ?? prefix);
    } finally {
      this.cardKeyPrefixSaving.set(false);
    }
  }

  private cardKeyPrefixErrorMessage(error: unknown): string {
    if (error instanceof ApiError) {
      if (error.status === 409) {
        return "That prefix is already reserved by another workspace in this organisation. Choose a different prefix.";
      }
      if (error.status === 0) return "You're offline. Reconnect and try again.";
    }
    return "Could not update the card key prefix. Try again.";
  }

  private async loadStandaloneGrouping(boardId: string) {
    this.standaloneGroupError.set(null);
    try {
      const [groups, board] = await Promise.all([
        this.api.get<StandaloneBoardGroup[]>("/clients/me/standalone-board-groups"),
        this.api.get<Pick<Board, "standaloneGroupId">>(`/boards/${boardId}`),
      ]);
      this.standaloneGroups.set([...groups].sort((a, b) => a.title.localeCompare(b.title)));
      const title = groups.find((group) => group.id === board.standaloneGroupId)?.title ?? "";
      this.standaloneGroupTitle.set(title);
      this.standaloneGroupSavedTitle = title;
    } catch (error) {
      this.standaloneGroupError.set(error instanceof Error ? error.message : "Could not load board group");
    }
  }

  async updateStandaloneGroup() {
    const boardId = this.settings.boardId();
    if (!boardId || this.standaloneGroupSaving()) return;
    const title = this.standaloneGroupTitle().trim();
    if (title.toLocaleLowerCase() === this.standaloneGroupSavedTitle.toLocaleLowerCase()) {
      this.standaloneGroupTitle.set(this.standaloneGroupSavedTitle);
      return;
    }
    const previous = this.standaloneGroupSavedTitle;
    this.standaloneGroupTitle.set(title);
    this.standaloneGroupSaving.set(true);
    this.standaloneGroupError.set(null);
    try {
      await this.api.patch(`/clients/me/standalone-boards/${boardId}/group`, { groupTitle: title || null });
      this.standaloneGroupSavedTitle = title;
    } catch (error) {
      this.standaloneGroupTitle.set(previous);
      this.standaloneGroupError.set(error instanceof Error ? error.message : "Could not update board group");
    } finally {
      this.standaloneGroupSaving.set(false);
    }
  }

  openStandaloneGroupMenu() {
    if (this.standaloneGroupSaving()) return;
    // An ungrouped standalone board may have no existing groups yet. Keep the free-text field
    // usable without opening an empty anchored panel; typing still adds the "create" choice.
    this.standaloneGroupMenuOpen.set(this.standaloneGroupChoices().length > 0);
    this.standaloneGroupActiveIndex.set(-1);
  }

  onStandaloneGroupInput(value: string) {
    this.standaloneGroupTitle.set(value);
    this.standaloneGroupMenuOpen.set(this.standaloneGroupChoices().length > 0);
    this.standaloneGroupActiveIndex.set(-1);
  }

  onStandaloneGroupFocusOut(event: FocusEvent) {
    const next = event.relatedTarget;
    // Moving focus into an option is still part of the composite control; only leaving it commits
    // free-typed text and closes the menu.
    if (next instanceof Node && (event.currentTarget as HTMLElement).contains(next)) return;
    this.standaloneGroupMenuOpen.set(false);
    void this.updateStandaloneGroup();
  }

  dismissStandaloneGroupMenu() {
    if (!this.standaloneGroupMenuOpen()) return;
    // A click on non-focusable page chrome does not move focus, so the stack dismissal also commits
    // free-typed text instead of relying on focusout alone.
    this.standaloneGroupMenuOpen.set(false);
    void this.updateStandaloneGroup();
  }

  onStandaloneGroupKeydown(event: KeyboardEvent) {
    const choices = this.standaloneGroupChoices();
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!choices.length) return;
      if (!this.standaloneGroupMenuOpen()) this.standaloneGroupMenuOpen.set(true);
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const current = this.standaloneGroupActiveIndex();
      const next = current < 0
        ? (direction > 0 ? 0 : choices.length - 1)
        : (current + direction + choices.length) % choices.length;
      this.standaloneGroupActiveIndex.set(next);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const choice = choices[this.standaloneGroupActiveIndex()];
      if (this.standaloneGroupMenuOpen() && choice) void this.selectStandaloneGroup(choice.title);
      else {
        this.standaloneGroupMenuOpen.set(false);
        void this.updateStandaloneGroup();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      this.standaloneGroupTitle.set(this.standaloneGroupSavedTitle);
      this.standaloneGroupMenuOpen.set(false);
      this.standaloneGroupActiveIndex.set(-1);
    }
  }

  async selectStandaloneGroup(title: string) {
    this.standaloneGroupTitle.set(title);
    this.standaloneGroupMenuOpen.set(false);
    this.standaloneGroupActiveIndex.set(-1);
    await this.updateStandaloneGroup();
  }

  clearStandaloneGroup() {
    void this.selectStandaloneGroup("");
  }
}
