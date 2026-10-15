import { EmptyStateComponent } from "../../../shared/empty-state.component";
import { CdkDrag, CdkDragHandle, CdkDropList } from "@angular/cdk/drag-drop";
import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { AutofocusDirective } from "../../../shared/autofocus.directive";
import { ColorPickerComponent } from "../../../shared/color-picker.component";
import { DocsLinkComponent } from "../../../shared/docs-link.component";
import { IconPickerComponent } from "../../../shared/icon-picker.component";
import { TooltipDirective } from "../../../shared/tooltip.directive";
import { WorkspaceSettingsPage } from "../workspace-settings.page";

@Component({
  selector: "k-workspace-settings-lists",
  standalone: true,
  imports: [EmptyStateComponent, AutofocusDirective, CdkDrag, CdkDragHandle, CdkDropList, ColorPickerComponent, DocsLinkComponent, IconPickerComponent, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./lists.page.html",
  styleUrl: "./lists.page.scss",
})
export class WorkspaceSettingsListsPage {
  protected readonly settings = inject(WorkspaceSettingsPage);

  protected renameLabel(name: string): string {
    return $localize`:Button aria-label:Rename ${name}:list:`;
  }

  protected inProgressToggleLabel(list: { name: string; inProgress: boolean }): string {
    const name = list.name;
    return list.inProgress
      ? $localize`:Button aria-label - stop treating this list as one where work is actively happening:Unmark ${name}:list: as in progress`
      : $localize`:Button aria-label - treat this list as one where work is actively happening:Mark ${name}:list: as in progress`;
  }

  protected inProgressToggleTooltip(list: { inProgress: boolean }): string {
    return list.inProgress
      ? $localize`:Tooltip on an active In progress toggle:In progress list: each card shows its time in progress`
      : $localize`:Tooltip on an inactive In progress toggle:Mark as In progress`;
  }

  constructor() {
    this.settings.selectedTab.set("lists");
  }
}
