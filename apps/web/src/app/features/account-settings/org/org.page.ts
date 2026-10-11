import { NgOptimizedImage } from "@angular/common";
import { ChangeDetectionStrategy, Component, computed, inject } from "@angular/core";
import { visibleSignedMediaUrl } from "../../../core/media/signed-media-url";
import { AutosaveStatusComponent } from "../../../shared/autosave-status.component";
import { DocsLinkComponent } from "../../../shared/docs-link.component";
import { AccountSettingsPage } from "../account-settings.page";

/** Organisation → General: identity, new-workspace defaults, navigation options and deletion. */
@Component({
  selector: "k-account-settings-org",
  standalone: true,
  imports: [AutosaveStatusComponent, DocsLinkComponent, NgOptimizedImage],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./org.page.html",
})
export class AccountSettingsOrgPage {
  protected readonly settings = inject(AccountSettingsPage);

  // Suppress an expired signed logo URL (e.g. from a cached settings payload) so
  // the preview falls back to the placeholder icon instead of a broken image.
  protected readonly visibleLogoUrl = computed(() => visibleSignedMediaUrl(this.settings.client()?.logoUrl ?? null));

  constructor() {
    this.settings.selectedTab.set("org");
  }
}
