import { NgOptimizedImage } from "@angular/common";
import { ChangeDetectionStrategy, Component, input } from "@angular/core";
import { AttachmentUploadListComponent } from "../../shared/attachments/attachment-upload-list.component";
import { TooltipDirective } from "../../shared/tooltip.directive";

import type { CardDetailAttachmentsModel } from "./card-detail-view-model";

@Component({
  selector: "k-card-detail-attachments",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgOptimizedImage, TooltipDirective, AttachmentUploadListComponent],
  templateUrl: "./card-detail-attachments.component.html",
  styles: ":host { display: contents; }",
})
export class CardDetailAttachmentsComponent {
  readonly model = input.required<CardDetailAttachmentsModel>();

}
