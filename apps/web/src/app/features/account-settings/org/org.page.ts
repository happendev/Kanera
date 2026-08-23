import { NgOptimizedImage } from "@angular/common";
import { ChangeDetectionStrategy, Component, computed, inject } from "@angular/core";
import { visibleSignedMediaUrl } from "../../../core/media/signed-media-url";
import { AnchoredPanelDirective } from "../../../shared/anchored-panel.directive";
import { DocsLinkComponent } from "../../../shared/docs-link.component";
import { TooltipDirective } from "../../../shared/tooltip.directive";
import { AccountSettingsPage } from "../account-settings.page";

@Component({
  selector: "k-account-settings-org",
  standalone: true,
  imports: [AnchoredPanelDirective, DocsLinkComponent, NgOptimizedImage, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./org.page.html",
  styleUrl: "./org.page.scss",
})
export class AccountSettingsOrgPage {
  protected readonly settings = inject(AccountSettingsPage);
  protected readonly smtpPanelPlacement = { width: 320, maxHeight: 360, minHeight: 190 } as const;

  // Suppress an expired signed logo URL (e.g. from a cached settings payload) so
  // the preview falls back to the placeholder icon instead of a broken image.
  protected readonly visibleLogoUrl = computed(() => visibleSignedMediaUrl(this.settings.client()?.logoUrl ?? null));

  constructor() {
    this.settings.selectedTab.set("org");
  }
}
