import type { ElementRef } from "@angular/core";
import { ChangeDetectionStrategy, Component, input, viewChild } from "@angular/core";
import { DraftBannerComponent } from "../../shared/draft-banner.component";
import { TooltipDirective } from "../../shared/tooltip.directive";
import { DescriptionEditorComponent } from "./description-editor.component";
import { DescriptionViewerComponent } from "./description-viewer.component";

import type { CardDetailDescriptionModel } from "./card-detail-view-model";

@Component({
  selector: "k-card-detail-description",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DraftBannerComponent, DescriptionEditorComponent, DescriptionViewerComponent, TooltipDirective],
  templateUrl: "./card-detail-description.component.html",
  styles: ":host { display: contents; }",
})
export class CardDetailDescriptionComponent {
  readonly model = input.required<CardDetailDescriptionModel>();
  readonly descriptionEditor = viewChild<DescriptionEditorComponent>("descriptionEditor");
  readonly descViewerInner = viewChild<ElementRef<HTMLElement>>("descViewerInner");
}
