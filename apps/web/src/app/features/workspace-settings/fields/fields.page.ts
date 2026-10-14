import { EmptyStateComponent } from "../../../shared/empty-state.component";
import { CdkDrag, CdkDragHandle, CdkDropList } from "@angular/cdk/drag-drop";
import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { AutofocusDirective } from "../../../shared/autofocus.directive";
import { ColorPickerComponent } from "../../../shared/color-picker.component";
import { DocsLinkComponent } from "../../../shared/docs-link.component";
import { IconPickerComponent } from "../../../shared/icon-picker.component";
import { TooltipDirective } from "../../../shared/tooltip.directive";
import type { CustomFieldTypeName } from "@kanera/shared/dto";
import { WorkspaceSettingsPage } from "../workspace-settings.page";

const fieldTypeLabels: Record<CustomFieldTypeName, string> = {
  text: $localize`:Custom field type badge:text`,
  number: $localize`:Custom field type badge:number`,
  checkbox: $localize`:Custom field type badge:checkbox`,
  select: $localize`:Custom field type badge — pick from a list of options:select`,
  date: $localize`:Custom field type badge:date`,
  url: $localize`:Custom field type badge:url`,
  user: $localize`:Custom field type badge — a workspace member:user`,
};

@Component({
  selector: "k-workspace-settings-fields",
  standalone: true,
  imports: [EmptyStateComponent, AutofocusDirective, CdkDrag, CdkDragHandle, CdkDropList, ColorPickerComponent, DocsLinkComponent, IconPickerComponent, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./fields.page.html",
  styleUrl: "./fields.page.scss",
})
export class WorkspaceSettingsFieldsPage {
  protected readonly settings = inject(WorkspaceSettingsPage);

  protected readonly multipleOnHint = $localize`Multiple values allowed - click for single`;
  protected readonly multipleOffHint = $localize`Single value - click to allow multiple`;
  protected readonly multipleOnLabel = $localize`Switch to single value`;
  protected readonly multipleOffLabel = $localize`Allow multiple values`;
  protected readonly showOnCardHint = $localize`Showing on card - click to hide`;
  protected readonly hiddenFromCardHint = $localize`Hidden from card - click to show`;
  protected readonly hideFromCardLabel = $localize`Hide from card`;
  protected readonly showOnCardLabel = $localize`Show on card`;

  /** Lower case, matching the type badge style. */
  protected fieldTypeLabel(type: CustomFieldTypeName): string {
    return fieldTypeLabels[type];
  }

  constructor() {
    this.settings.selectedTab.set("fields");
  }
}
