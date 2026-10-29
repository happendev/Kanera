import { ChangeDetectionStrategy, Component, input } from "@angular/core";
import { AvatarComponent } from "../../shared/avatar.component";
import { TooltipDirective } from "../../shared/tooltip.directive";
import { DatePickerPopover } from "./date-picker.popover";
import { MemberPickerPopover } from "./member-picker.popover";
import { SelectPickerPopover } from "./select-picker.popover";

import type { CardDetailFieldsModel } from "./card-detail-view-model";

@Component({
  selector: "k-card-detail-fields",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AvatarComponent, MemberPickerPopover, DatePickerPopover, SelectPickerPopover, TooltipDirective],
  templateUrl: "./card-detail-fields.component.html",
  styles: ":host { display: contents; }",
})
export class CardDetailFieldsComponent {
  readonly model = input.required<CardDetailFieldsModel>();

}
