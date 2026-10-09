import { NgOptimizedImage } from "@angular/common";
import { ChangeDetectionStrategy, Component, computed, inject } from "@angular/core";
import type { ClientMcpPolicy } from "@kanera/shared/schema";
import { visibleSignedMediaUrl } from "../../../core/media/signed-media-url";
import { AnchoredPanelDirective } from "../../../shared/anchored-panel.directive";
import { AutosaveStatusComponent } from "../../../shared/autosave-status.component";
import { DocsLinkComponent } from "../../../shared/docs-link.component";
import { SegmentedComponent, type SegmentedOption } from "../../../shared/segmented.component";
import { TooltipDirective } from "../../../shared/tooltip.directive";
import { AccountSettingsPage } from "../account-settings.page";

@Component({
  selector: "k-account-settings-org",
  standalone: true,
  imports: [AnchoredPanelDirective, AutosaveStatusComponent, DocsLinkComponent, NgOptimizedImage, SegmentedComponent, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./org.page.html",
})
export class AccountSettingsOrgPage {
  protected readonly settings = inject(AccountSettingsPage);
  protected readonly smtpPanelPlacement = { width: 320, maxHeight: 360, minHeight: 190 } as const;

  // Suppress an expired signed logo URL (e.g. from a cached settings payload) so
  // the preview falls back to the placeholder icon instead of a broken image.
  protected readonly visibleLogoUrl = computed(() => visibleSignedMediaUrl(this.settings.client()?.logoUrl ?? null));

  protected readonly mcpPolicyOptions: readonly SegmentedOption<ClientMcpPolicy>[] = [
    { id: "off", icon: "plug-connected-x", label: "Off" },
    { id: "read", icon: "eye", label: "Read only" },
    { id: "write", icon: "pencil", label: "Read and write" },
  ];
  protected readonly mcpPolicyHelp = computed(() => {
    switch (this.settings.mcpPolicyDraft()) {
      case "off": return "Agents cannot see or change anything in this organisation. Existing connections stay listed, but their requests are refused.";
      case "read": return "Agents can read boards, cards and notes but cannot change them, even for members who can.";
      case "write": return "Agents act with the same permissions as the member who connected them.";
    }
  });

  constructor() {
    this.settings.selectedTab.set("org");
  }
}
