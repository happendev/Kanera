import { NgOptimizedImage } from "@angular/common";
import type { ElementRef } from "@angular/core";
import { ChangeDetectionStrategy, Component, input, viewChild } from "@angular/core";
import { AnchoredPanelDirective } from "../../shared/anchored-panel.directive";
import { TooltipDirective } from "../../shared/tooltip.directive";
import { BoardPickerPopover } from "./board-picker.popover";
import { ReminderPopoverComponent } from "./reminder-popover.component";
import { WatcherPopoverComponent } from "./watcher-popover.component";

import type { CardDetailHeaderModel } from "./card-detail-view-model";

@Component({
  selector: "k-card-detail-header",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgOptimizedImage, AnchoredPanelDirective, BoardPickerPopover, TooltipDirective, WatcherPopoverComponent, ReminderPopoverComponent],
  templateUrl: "./card-detail-header.component.html",
  styles: ":host { display: contents; }",
})
export class CardDetailHeaderComponent {
  readonly model = input.required<CardDetailHeaderModel>();
  readonly titleInput = viewChild<ElementRef<HTMLInputElement>>("titleInput");
}
