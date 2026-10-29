import { CdkDrag, CdkDragHandle, CdkDragPreview, CdkDropList } from "@angular/cdk/drag-drop";
import { NgTemplateOutlet } from "@angular/common";
import type { ElementRef, TemplateRef } from "@angular/core";
import { ChangeDetectionStrategy, Component, input, viewChild } from "@angular/core";
import type { WireCardChecklist } from "@kanera/shared/events";
import { AnchoredPanelDirective } from "../../shared/anchored-panel.directive";
import { AvatarComponent } from "../../shared/avatar.component";
import { TooltipDirective } from "../../shared/tooltip.directive";
import { DatePickerPopover } from "./date-picker.popover";
import { MemberPickerPopover } from "./member-picker.popover";

import type { CardDetailChecklistsModel } from "./card-detail-view-model";

@Component({
  selector: "k-card-detail-checklists",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, CdkDropList, CdkDrag, CdkDragHandle, CdkDragPreview, AnchoredPanelDirective, AvatarComponent, MemberPickerPopover, DatePickerPopover, TooltipDirective],
  templateUrl: "./card-detail-checklists.component.html",
  styles: ":host { display: contents; }",
})
export class CardDetailChecklistsComponent {
  readonly model = input.required<CardDetailChecklistsModel>();
  readonly addItemInput = viewChild<ElementRef<HTMLInputElement>>("addItemInput");
  readonly addChecklistInput = viewChild<ElementRef<HTMLInputElement>>("addChecklistInput");
  readonly checklistTitleInput = viewChild<ElementRef<HTMLInputElement>>("checklistTitleInput");
  readonly checklistItemInput = viewChild<ElementRef<HTMLInputElement>>("checklistItemInput");
  readonly checklistList = viewChild.required<TemplateRef<{ checklists: WireCardChecklist[]; showItemMeta: boolean }>>("checklistList");
}
