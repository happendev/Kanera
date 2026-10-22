import { EmptyStateComponent } from "../../../shared/empty-state.component";
import { CdkDrag, CdkDragHandle, CdkDropList } from "@angular/cdk/drag-drop";
import { ChangeDetectionStrategy, Component, computed, inject } from "@angular/core";
import { DocsLinkComponent } from "../../../shared/docs-link.component";
import { BoardMembersMenu } from "../../shared/board-members-menu.popover";
import { TooltipDirective } from "../../../shared/tooltip.directive";
import { ColorPickerComponent } from "../../../shared/color-picker.component";
import { IconPickerComponent } from "../../../shared/icon-picker.component";
import { BoardIconComponent } from "../../../shared/board-icon.component";
import { BoardTileSummaryComponent } from "../../../shared/board-tile-summary.component";
import { WorkspaceSettingsPage } from "../workspace-settings.page";

@Component({
  selector: "k-workspace-settings-boards",
  standalone: true,
  imports: [EmptyStateComponent, BoardIconComponent, BoardMembersMenu, BoardTileSummaryComponent, CdkDrag, CdkDragHandle, CdkDropList, ColorPickerComponent, DocsLinkComponent, IconPickerComponent, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./boards.page.html",
  styleUrl: "./boards.page.scss",
})
export class WorkspaceSettingsBoardsPage {
  protected readonly settings = inject(WorkspaceSettingsPage);
  protected readonly boardSections = computed(() => {
    const boards = this.settings.boardList();
    const boardsByGroup = new Map<string | null, typeof boards>();
    for (const board of boards) {
      const groupId = board.groupId ?? null;
      const bucket = boardsByGroup.get(groupId);
      if (bucket) bucket.push(board);
      else boardsByGroup.set(groupId, [board]);
    }
    // Match the expanded navigation: nonempty groups in group order, then ungrouped boards.
    // Each bucket preserves board position order and supplies its own drag indices and anchors.
    return [
      ...this.settings.boardGroups().map((group) => ({
        id: group.id, title: group.title, boards: boardsByGroup.get(group.id) ?? [],
      })),
      { id: null, title: null, boards: boardsByGroup.get(null) ?? [] },
    ].filter((section) => section.boards.length > 0);
  });

  constructor() {
    this.settings.selectedTab.set("boards");
  }
}
