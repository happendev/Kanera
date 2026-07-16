import { ChangeDetectionStrategy, Component, effect, inject, signal, untracked } from "@angular/core";
import type { Board, StandaloneBoardGroup } from "@kanera/shared/schema";
import { ApiClient } from "../../../core/api/api.client";
import { ColorPickerComponent } from "../../../shared/color-picker.component";
import { IconPickerComponent } from "../../../shared/icon-picker.component";
import { WorkspaceSettingsPage } from "../workspace-settings.page";

@Component({
  selector: "k-workspace-settings-general",
  standalone: true,
  imports: [IconPickerComponent, ColorPickerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./general.page.html",
  styleUrl: "./general.page.scss",
})
export class WorkspaceSettingsGeneralPage {
  protected readonly settings = inject(WorkspaceSettingsPage);
  private readonly api = inject(ApiClient);
  private loadedBoardId: string | null = null;
  readonly standaloneGroups = signal<StandaloneBoardGroup[]>([]);
  readonly standaloneGroupTitle = signal("");
  private standaloneGroupSavedTitle = "";
  readonly standaloneGroupSaving = signal(false);
  readonly standaloneGroupError = signal<string | null>(null);

  constructor() {
    this.settings.selectedTab.set("general");
    effect(() => {
      const boardId = this.settings.boardId();
      if (!this.settings.isStandalone() || !boardId || boardId === this.loadedBoardId) return;
      this.loadedBoardId = boardId;
      untracked(() => void this.loadStandaloneGrouping(boardId));
    });
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
}
