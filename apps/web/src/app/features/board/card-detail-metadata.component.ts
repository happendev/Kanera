import { ChangeDetectionStrategy, Component, input } from "@angular/core";
import { AvatarComponent } from "../../shared/avatar.component";
import { TooltipDirective } from "../../shared/tooltip.directive";
import { DatePickerPopover } from "./date-picker.popover";
import { LabelPickerPopover } from "./label-picker.popover";
import { MemberPickerPopover } from "./member-picker.popover";

import type { CardDetailMetadataModel } from "./card-detail-view-model";

@Component({
  selector: "k-card-detail-metadata",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AvatarComponent, MemberPickerPopover, LabelPickerPopover, DatePickerPopover, TooltipDirective],
  templateUrl: "./card-detail-metadata.component.html",
  styles: ":host { display: contents; }",
})
export class CardDetailMetadataComponent {
  readonly model = input.required<CardDetailMetadataModel>();

}
